import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { unauthorizedHint, type AuthProvider } from "../auth/types";
import { TtlCache } from "./cache";
import {
	AzdoError,
	type AzdoProject,
	type RawWorkItem,
	type WorkItem,
	type WorkItemTypeInfo,
} from "./types";

const API_VERSION = "7.0";

const WORK_ITEM_FIELDS = [
	"System.Id",
	"System.Title",
	"System.WorkItemType",
	"System.State",
	"System.AssignedTo",
	"System.IterationPath",
	"System.AreaPath",
	"System.Tags",
	"System.TeamProject",
	"System.Description",
];

export interface AzdoClientConfig {
	organizationUrl: string;
	project: string;
	auth: AuthProvider;
	cacheTtlMs: number;
}

export interface SearchOptions {
	/** Free text or a work item id. */
	query: string;
	limit: number;
	/** Restrict to the configured project, or search the whole organization. */
	scope: "project" | "organization";
	/** What to return when the query is empty. */
	emptyQueryMode: "recent" | "assignedToMe" | "none";
}

/** Reference to a work item parsed out of an Azure DevOps URL. */
export interface WorkItemRef {
	id: number;
	project?: string;
	organizationUrl?: string;
}

function normaliseBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/**
 * Percent-encode a path segment. `encodeURIComponent` leaves parentheses alone,
 * which would break the markdown link the plugin writes into notes.
 */
export function encodeUrlSegment(value: string): string {
	return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** `decodeURIComponent` throws on malformed escapes; notes can contain anything. */
function decodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function escapeWiql(value: string): string {
	return value.replace(/'/g, "''");
}

function stripHtml(html: string): string {
	const withBreaks = html
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n");
	// DOMParser produces an inert document: no scripts run and no resources load.
	const parsed = new DOMParser().parseFromString(withBreaks, "text/html");
	return (parsed.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

function readIdentity(value: unknown): { name?: string; image?: string } {
	if (!value) return {};
	if (typeof value === "string") return { name: value };
	if (typeof value === "object") {
		const identity = value as Record<string, unknown>;
		return {
			name:
				(identity.displayName as string) ??
				(identity.uniqueName as string) ??
				undefined,
			image: (identity.imageUrl as string) ?? undefined,
		};
	}
	return {};
}

export class AzdoClient {
	private config: AzdoClientConfig;

	readonly workItems: TtlCache<WorkItem>;
	private typeCache: TtlCache<WorkItemTypeInfo[]>;
	/** In-flight single work item lookups, so concurrent renderers share one batch. */
	private pending = new Map<string, Promise<WorkItem | null>>();
	/** Ids that resolved to "not found / no access", so we stop retrying them constantly. */
	private missing = new TtlCache<true>(5 * 60 * 1000);

	constructor(config: AzdoClientConfig) {
		this.config = config;
		this.workItems = new TtlCache<WorkItem>(config.cacheTtlMs);
		this.typeCache = new TtlCache<WorkItemTypeInfo[]>(60 * 60 * 1000);
	}

	updateConfig(config: AzdoClientConfig): void {
		const orgChanged =
			normaliseBaseUrl(config.organizationUrl) !==
				normaliseBaseUrl(this.config.organizationUrl) ||
			config.auth !== this.config.auth ||
			config.project !== this.config.project;

		this.config = config;
		this.workItems.setTtl(config.cacheTtlMs);
		if (orgChanged) this.clearCaches();
	}

	clearCaches(): void {
		this.workItems.clear();
		this.typeCache.clear();
		this.missing.clear();
		this.pending.clear();
	}

	get isConfigured(): boolean {
		return Boolean(normaliseBaseUrl(this.config.organizationUrl)) && this.config.auth.isConfigured;
	}

	get auth(): AuthProvider {
		return this.config.auth;
	}

	get organizationUrl(): string {
		return normaliseBaseUrl(this.config.organizationUrl);
	}

	get project(): string {
		return this.config.project.trim();
	}

	// ---------------------------------------------------------------- requests

	private buildUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
		const base = this.organizationUrl;
		if (!base) throw new AzdoError("Azure DevOps organization URL is not configured.");

		const url = new URL(`${base}${path}`);
		// Build the query manually: Azure DevOps expects literal `$top` and comma
		// separated id lists, which URLSearchParams would percent-encode.
		const query = [`api-version=${API_VERSION}`];
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === "") continue;
			const encoded = encodeURIComponent(String(value)).replace(/%2C/g, ",");
			query.push(`${key}=${encoded}`);
		}
		url.search = query.join("&");
		return url.toString();
	}

	private async request<T>(
		url: string,
		init: Partial<RequestUrlParam> = {},
	): Promise<T> {
		const auth = this.config.auth;
		try {
			return await this.attempt<T>(url, init, auth);
		} catch (error) {
			// A bearer token can be revoked or rotated before it expires; drop the
			// cached one and let the provider fetch a fresh one exactly once.
			if (!(error instanceof AzdoError) || !error.retryable || !auth.canRetryAfterUnauthorized) {
				throw error;
			}
			auth.invalidate();
			return await this.attempt<T>(url, init, auth);
		}
	}

	private async attempt<T>(
		url: string,
		init: Partial<RequestUrlParam>,
		auth: AuthProvider,
	): Promise<T> {
		const authorization = await auth.getAuthHeader();

		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url,
				method: init.method ?? "GET",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: authorization,
					"X-TFS-FedAuthRedirect": "Suppress",
					...(init.headers ?? {}),
				},
				body: init.body,
				throw: false,
			});
		} catch (error) {
			throw new AzdoError(
				`Could not reach Azure DevOps: ${(error as Error).message}`,
				undefined,
				"Check the organization URL and your network connection.",
			);
		}

		const contentType = response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "";

		// Azure DevOps answers an unauthenticated request with a sign-in page.
		if (contentType.includes("text/html")) {
			throw new AzdoError(
				"Azure DevOps returned a sign-in page instead of data.",
				response.status,
				unauthorizedHint(auth.mode),
				true,
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new AzdoError(
				"Azure DevOps rejected the credentials.",
				response.status,
				unauthorizedHint(auth.mode),
				response.status === 401,
			);
		}

		if (response.status === 404) {
			throw new AzdoError(
				"Azure DevOps resource not found.",
				404,
				"Check the organization URL and project name.",
			);
		}

		if (response.status >= 400) {
			let detail = "";
			try {
				detail = (response.json as { message?: string })?.message ?? "";
			} catch {
				detail = response.text?.slice(0, 200) ?? "";
			}
			throw new AzdoError(
				detail || `Azure DevOps request failed (HTTP ${response.status}).`,
				response.status,
			);
		}

		return response.json as T;
	}

	// ------------------------------------------------------------- public API

	async testConnection(): Promise<{ projects: AzdoProject[] }> {
		const result = await this.request<{ value: AzdoProject[] }>(
			this.buildUrl("/_apis/projects", { $top: 500 }),
		);
		return { projects: result.value ?? [] };
	}

	async listProjects(): Promise<AzdoProject[]> {
		const result = await this.request<{ value: AzdoProject[] }>(
			this.buildUrl("/_apis/projects", { $top: 500 }),
		);
		return result.value ?? [];
	}

	/**
	 * Work item type metadata (colour + icon + states) for a project.
	 *
	 * Different projects can use different processes, so this is cached per project
	 * rather than globally.
	 */
	async getWorkItemTypes(project?: string): Promise<WorkItemTypeInfo[]> {
		const target = (project ?? this.project).trim();
		if (!target || !this.isConfigured) return [];
		return this.typeCache.resolve(target.toLowerCase(), async () => {
			const result = await this.request<{ value: RawWorkItemType[] }>(
				this.buildUrl(`/${encodeUrlSegment(target)}/_apis/wit/workitemtypes`),
			);
			return (result.value ?? []).map((type) => ({
				name: type.name,
				referenceName: type.referenceName,
				color: type.color,
				iconId: type.icon?.id,
				iconUrl: type.icon?.url,
				states: (type.states ?? []).map((state) => ({
					name: state.name,
					color: state.color,
					category: state.category,
				})),
			}));
		});
	}

	/** Fetch one work item, using the cache when possible. */
	async getWorkItem(id: number): Promise<WorkItem | null> {
		const items = await this.getWorkItems([id]);
		return items.get(id) ?? null;
	}

	/**
	 * Fetch several work items at once.
	 *
	 * Cached items are returned immediately, ids that another caller is already
	 * fetching are awaited rather than requested again, and only the remainder
	 * produces a new batch request.
	 */
	async getWorkItems(ids: number[]): Promise<Map<number, WorkItem>> {
		const found = new Map<number, WorkItem>();
		const awaited: Promise<void>[] = [];
		const toFetch: number[] = [];

		for (const id of new Set(ids)) {
			const key = String(id);

			const cached = this.workItems.get(key);
			if (cached) {
				found.set(id, cached);
				continue;
			}

			const pending = this.pending.get(key);
			if (pending) {
				awaited.push(
					pending.then((item) => {
						if (item) found.set(id, item);
					}),
				);
				continue;
			}

			if (this.missing.get(key)) continue;
			toFetch.push(id);
		}

		if (toFetch.length > 0) {
			awaited.push(this.fetchAndDistribute(toFetch, found));
		}

		await Promise.all(awaited);
		return found;
	}

	/** Runs one batch request and settles the per-id promises it covers. */
	private async fetchAndDistribute(
		ids: number[],
		found: Map<number, WorkItem>,
	): Promise<void> {
		const deferred = new Map<number, { resolve: (item: WorkItem | null) => void; reject: (error: unknown) => void }>();
		// Remember the exact promises we published so a late `finally` cannot evict
		// a newer in-flight request that replaced ours after `clearCaches()`.
		const published = new Map<string, Promise<WorkItem | null>>();

		for (const id of ids) {
			const key = String(id);
			const promise = new Promise<WorkItem | null>((resolve, reject) => {
				deferred.set(id, { resolve, reject });
			});
			// Nothing awaits a rejection here, so keep the runtime from reporting it twice.
			promise.catch(() => undefined);
			this.pending.set(key, promise);
			published.set(key, promise);
		}

		const generation = this.workItems.currentGeneration;

		try {
			const fetched = await this.fetchWorkItems(ids);
			for (const id of ids) {
				const key = String(id);
				const item = fetched.get(id) ?? null;
				if (item) {
					this.workItems.setIfCurrent(key, item, generation);
					this.missing.delete(key);
					found.set(id, item);
				} else if (generation === this.workItems.currentGeneration) {
					// The batch call succeeded but omitted this id: it is deleted or
					// outside the token's access. Remember that briefly.
					this.missing.set(key, true);
				}
				deferred.get(id)?.resolve(item);
			}
		} catch (error) {
			// A transport or authorization failure says nothing about the work items
			// themselves, so it must not be cached as "missing".
			for (const id of ids) deferred.get(id)?.reject(error);
			throw error;
		} finally {
			for (const [key, promise] of published) {
				if (this.pending.get(key) === promise) this.pending.delete(key);
			}
		}
	}

	/**
	 * Fetch work items by id at organization scope.
	 *
	 * Ids are unique across the organization and follow a work item when it moves
	 * between projects, so scoping the request to a project would make a link that
	 * still names the old project look deleted.
	 */
	private async fetchWorkItems(ids: number[]): Promise<Map<number, WorkItem>> {
		const result = new Map<number, WorkItem>();
		if (ids.length === 0) return result;

		// The batch endpoint accepts at most 200 ids per call.
		for (let offset = 0; offset < ids.length; offset += 200) {
			const chunk = ids.slice(offset, offset + 200);
			const response = await this.request<{ value: RawWorkItem[] }>(
				this.buildUrl(`/_apis/wit/workitems`, {
					ids: chunk.join(","),
					fields: WORK_ITEM_FIELDS.join(","),
					errorPolicy: "omit",
				}),
			);
			for (const raw of response.value ?? []) {
				if (!raw?.id) continue;
				const item = this.normaliseWorkItem(raw);
				result.set(item.id, item);
			}
		}

		return result;
	}

	private normaliseWorkItem(raw: RawWorkItem): WorkItem {
		const fields = raw.fields ?? {};
		const identity = readIdentity(fields["System.AssignedTo"]);
		const tagsRaw = (fields["System.Tags"] as string) ?? "";
		const descriptionRaw = (fields["System.Description"] as string) ?? "";
		const project = (fields["System.TeamProject"] as string) ?? this.project;

		return {
			id: raw.id,
			title: (fields["System.Title"] as string) ?? `Work item ${raw.id}`,
			type: (fields["System.WorkItemType"] as string) ?? "Work Item",
			state: (fields["System.State"] as string) ?? "",
			assignedTo: identity.name,
			assignedToImage: identity.image,
			iterationPath: fields["System.IterationPath"] as string | undefined,
			areaPath: fields["System.AreaPath"] as string | undefined,
			tags: tagsRaw
				.split(";")
				.map((tag) => tag.trim())
				.filter(Boolean),
			description: descriptionRaw ? stripHtml(descriptionRaw) : undefined,
			project,
			url:
				raw._links?.html?.href ??
				this.buildWorkItemUrl(raw.id, project),
			fetchedAt: Date.now(),
		};
	}

	/** Search work items by id or free text, newest first. */
	async search(options: SearchOptions): Promise<WorkItem[]> {
		if (!this.isConfigured) return [];

		const query = options.query.trim();
		const useProjectScope = options.scope === "project" && Boolean(this.project);
		const scopePath = useProjectScope ? `/${encodeUrlSegment(this.project)}` : "";

		const conditions: string[] = ["[System.State] <> 'Removed'"];
		if (useProjectScope) {
			conditions.push(`[System.TeamProject] = '${escapeWiql(this.project)}'`);
		}

		if (query.length === 0) {
			if (options.emptyQueryMode === "none") return [];
			if (options.emptyQueryMode === "assignedToMe") {
				conditions.push("[System.AssignedTo] = @Me");
			} else {
				conditions.push("[System.ChangedDate] >= @Today - 60");
			}
		} else if (/^\d+$/.test(query)) {
			// A bare number: prefer the exact id, but still offer title matches.
			conditions.push(
				`([System.Id] = ${Number(query)} OR [System.Title] CONTAINS '${escapeWiql(query)}')`,
			);
		} else {
			conditions.push(`[System.Title] CONTAINS '${escapeWiql(query)}'`);
		}

		const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(
			" AND ",
		)} ORDER BY [System.ChangedDate] DESC`;

		const response = await this.request<{ workItems?: { id: number }[] }>(
			this.buildUrl(`${scopePath}/_apis/wit/wiql`, { $top: options.limit }),
			{ method: "POST", body: JSON.stringify({ query: wiql }) },
		);

		const ids = (response.workItems ?? []).map((entry) => entry.id).slice(0, options.limit);
		if (ids.length === 0) return [];

		const items = await this.getWorkItems(ids);

		// WIQL already sorted the ids; keep that order, but float an exact id match to the top.
		const ordered = ids
			.map((id) => items.get(id))
			.filter((item): item is WorkItem => Boolean(item));

		if (/^\d+$/.test(query)) {
			const exact = Number(query);
			ordered.sort((a, b) => Number(b.id === exact) - Number(a.id === exact));
		}

		return ordered;
	}

	buildWorkItemUrl(id: number, project?: string): string {
		const target = (project ?? this.project).trim();
		const base = this.organizationUrl;
		return target
			? `${base}/${encodeUrlSegment(target)}/_workitems/edit/${id}`
			: `${base}/_workitems/edit/${id}`;
	}
}

interface RawWorkItemType {
	name: string;
	referenceName?: string;
	color?: string;
	icon?: { id?: string; url?: string };
	states?: { name: string; color?: string; category?: string }[];
}

/**
 * Parse an Azure DevOps work item URL.
 *
 * Handles both hosted and on-premises shapes:
 *   https://dev.azure.com/org/project/_workitems/edit/123
 *   https://org.visualstudio.com/project/_workitems/edit/123
 *   https://tfs.local/tfs/Collection/project/_workitems/edit/123
 *   .../_workitems?id=123  and  .../_workitems/edit/123/Some-Title
 */
export function parseWorkItemUrl(rawUrl: string): WorkItemRef | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}

	const segments = url.pathname.split("/").filter(Boolean).map(decodePathSegment);
	const anchor = segments.findIndex((segment) => segment.toLowerCase() === "_workitems");
	if (anchor === -1) return null;

	let id: number | undefined;
	const editIndex = segments.findIndex(
		(segment, index) => index > anchor && segment.toLowerCase() === "edit",
	);
	if (editIndex !== -1 && segments[editIndex + 1]) {
		const raw = segments[editIndex + 1];
		if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0) {
			id = Number(raw);
		}
	}

	if (id === undefined) {
		const queryId = url.searchParams.get("id") ?? url.searchParams.get("workitem");
		if (queryId && /^\d+$/.test(queryId)) id = Number(queryId);
	}

	if (id === undefined) return null;

	const host = url.hostname.toLowerCase();
	const isHostedRoot = host === "dev.azure.com" || host.endsWith(".dev.azure.com");

	let project: string | undefined;
	let orgSegments: string[];

	if (anchor === 0) {
		// https://org.visualstudio.com/_workitems/edit/1
		orgSegments = [];
	} else if (isHostedRoot && anchor === 1) {
		// https://dev.azure.com/org/_workitems/edit/1 — the single segment is the organization.
		orgSegments = segments.slice(0, 1);
	} else {
		// The segment directly before `_workitems` is the project; everything before it
		// is the organization or on-premises collection path.
		project = segments[anchor - 1];
		orgSegments = segments.slice(0, anchor - 1);
	}

	const organizationUrl = [url.origin, ...orgSegments.map(encodeUrlSegment)]
		.join("/")
		.replace(/\/+$/, "");

	return { id, project, organizationUrl };
}
