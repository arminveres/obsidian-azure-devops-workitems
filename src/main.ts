import {
	type Editor,
	MarkdownView,
	Notice,
	Plugin,
	type EditorPosition,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { AzdoClient, parseWorkItemUrl } from "./azdo/client";
import { AzdoError, type WorkItem, type WorkItemTypeInfo } from "./azdo/types";
import { AzureCliAuthProvider } from "./auth/cliProvider";
import {
	DEFAULT_PROTOCOL_ACTION,
	EntraAuthProvider,
	protocolAction,
	type EntraConfig,
} from "./auth/entraProvider";
import { PatAuthProvider } from "./auth/patProvider";
import type { AuthMode, AuthProvider } from "./auth/types";
import { type ChipDisplayOptions, typeAbbreviation } from "./chip";
import { HoverPreview } from "./hover";
import { WorkItemSearchModal } from "./modal";
import { sameOrganization } from "./reference";
import { createLivePreviewExtension, refreshChipsEffect } from "./render/livePreview";
import { createWorkItemPostProcessor } from "./render/postprocessor";
import { AzdoSettingTab, DEFAULT_SETTINGS, type AzdoSettings } from "./settings";
import { SignInModal } from "./signInModal";
import { WorkItemSuggest } from "./suggest";

/** Key for the type metadata of the default project. */
const DEFAULT_PROJECT_KEY = "\u0000default";

export default class AzdoPlugin extends Plugin {
	settings: AzdoSettings = { ...DEFAULT_SETTINGS };
	client!: AzdoClient;
	auth!: AuthProvider;

	/** Bumped whenever chips need to be rebuilt (settings change, cache clear). */
	renderRevision = 0;

	/** Work item type metadata per project — processes differ between projects. */
	private typeIndex = new Map<string, Map<string, WorkItemTypeInfo>>();
	private typeLoads = new Map<string, Promise<void>>();
	/** Invalidates type metadata loads that were started before a settings change. */
	private configGeneration = 0;

	private editorViews = new Set<EditorView>();
	private openModals = new Set<WorkItemSearchModal>();
	private protocolActions = new Set<string>();
	private signInModal: SignInModal | null = null;
	private hover!: HoverPreview;
	private suggest!: WorkItemSuggest;
	private lastErrorNotice = 0;
	private refreshTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.auth = this.createAuthProvider(this.settings.authMode);

		this.client = new AzdoClient({
			organizationUrl: this.settings.organizationUrl,
			project: this.settings.project,
			auth: this.auth,
			cacheTtlMs: this.settings.cacheTtlMinutes * 60 * 1000,
		});

		this.registerProtocolCallback();

		this.suggest = new WorkItemSuggest(this.app, this);
		this.registerEditorSuggest(this.suggest);

		this.registerMarkdownPostProcessor(createWorkItemPostProcessor(this));
		this.registerEditorExtension(createLivePreviewExtension(this));

		this.hover = new HoverPreview(this);
		this.hover.register();

		this.addSettingTab(new AzdoSettingTab(this.app, this));
		this.registerCommands();
		this.registerPasteHandler();

		// Warm the work item type metadata so the first chip already has colours.
		this.app.workspace.onLayoutReady(() => {
			if (this.client.isConfigured) void this.ensureTypeInfo();
		});
	}

	onunload(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.signInModal?.closeSilently();
		this.signInModal = null;
		this.auth?.dispose();
		this.suggest?.dispose();
		this.hover?.destroy();
		for (const modal of [...this.openModals]) modal.close();
		this.openModals.clear();
		this.editorViews.clear();
	}

	// ------------------------------------------------------------------ settings

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<AzdoSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.syncAuthProvider();
		this.registerProtocolCallback();
		this.client.updateConfig({
			organizationUrl: this.settings.organizationUrl,
			project: this.settings.project,
			auth: this.auth,
			cacheTtlMs: this.settings.cacheTtlMinutes * 60 * 1000,
		});
		this.invalidateTypeInfo();
		this.scheduleRefresh();
	}

	/** Coalesce the re-render that follows rapid setting edits (typing a PAT, dragging a slider). */
	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refreshAllViews();
		}, 400);
	}

	// -------------------------------------------------------------- work item data

	private invalidateTypeInfo(): void {
		this.configGeneration++;
		this.typeIndex.clear();
		this.typeLoads.clear();
	}

	private typeKey(project?: string): string {
		const trimmed = project?.trim();
		return trimmed ? trimmed.toLowerCase() : DEFAULT_PROJECT_KEY;
	}

	/** Loads work item type metadata (colours, icons, state categories) for a project once. */
	ensureTypeInfo(project?: string): Promise<void> {
		const key = this.typeKey(project);
		if (this.typeIndex.has(key)) return Promise.resolve();

		const existing = this.typeLoads.get(key);
		if (existing) return existing;

		const generation = this.configGeneration;
		const load = this.client
			.getWorkItemTypes(project)
			.then((types) => {
				// Discard results that belong to a configuration we have since left.
				if (generation !== this.configGeneration) return;
				const index = new Map<string, WorkItemTypeInfo>();
				for (const type of types) index.set(type.name.toLowerCase(), type);
				this.typeIndex.set(key, index);
			})
			.catch((error) => {
				// Colour metadata is a nicety — fall back to the built-in palette.
				this.logError(error);
			})
			.finally(() => {
				if (this.typeLoads.get(key) === load) this.typeLoads.delete(key);
			});

		this.typeLoads.set(key, load);
		return load;
	}

	getTypeInfo(typeName: string, project?: string): WorkItemTypeInfo | undefined {
		const name = typeName.trim().toLowerCase();
		return (
			this.typeIndex.get(this.typeKey(project))?.get(name) ??
			this.typeIndex.get(DEFAULT_PROJECT_KEY)?.get(name)
		);
	}

	/** Load the type metadata every one of these items needs, in parallel. */
	async warmTypeInfo(items: readonly WorkItem[]): Promise<void> {
		const projects = new Set(items.map((item) => item.project));
		await Promise.all([...projects].map((project) => this.ensureTypeInfo(project)));
	}

	chipOptions(): ChipDisplayOptions {
		return {
			showTypeIcon: this.settings.showTypeIcon,
			showTitle: this.settings.showTitle,
			showState: this.settings.showState,
			showAssignee: this.settings.showAssignee,
			maxTitleLength: this.settings.maxTitleLength,
			strikeThroughClosed: this.settings.strikeThroughClosed,
			nativeTooltip: !this.settings.enableHoverPreview,
		};
	}

	isKnownOrganization(organizationUrl: string | undefined): boolean {
		if (!this.settings.organizationUrl.trim()) return false;
		return sameOrganization(organizationUrl, this.settings.organizationUrl);
	}

	// ----------------------------------------------------------------- insertion

	/** Markdown written into the note for a work item. */
	buildWorkItemMarkdown(item: WorkItem): string {
		const values: Record<string, string> = {
			id: String(item.id),
			title: item.title,
			type: item.type,
			typeAbbrev: typeAbbreviation(item.type),
			state: item.state,
		};

		// One pass, so a title that itself contains `{state}` is not substituted again.
		const label = this.settings.linkLabelTemplate
			.replace(/\{(id|title|type|typeAbbrev|state)\}/g, (_match, key: string) => values[key])
			.trim();

		return `[${escapeLinkLabel(label || `#${item.id}`)}](${formatUrl(item.url)})`;
	}

	// ------------------------------------------------------------------ commands

	private registerCommands(): void {
		this.addCommand({
			id: "insert-work-item",
			name: "Insert work item reference",
			editorCallback: (editor: Editor) => {
				const modal = new WorkItemSearchModal(this.app, this, (item) => {
					editor.replaceSelection(this.buildWorkItemMarkdown(item));
				});
				this.openModals.add(modal);
				modal.open();
			},
		});

		this.addCommand({
			id: "refresh-work-items",
			name: "Refresh work item data",
			callback: () => {
				this.client.clearCaches();
				this.invalidateTypeInfo();
				this.refreshAllViews();
				new Notice("Azure DevOps work item data refreshed.");
			},
		});

		this.addCommand({
			id: "test-connection",
			name: "Test connection",
			callback: async () => {
				try {
					const { projects } = await this.client.testConnection();
					new Notice(`Connected to Azure DevOps. ${projects.length} project(s) visible.`);
				} catch (error) {
					this.reportError(error, "Connection failed");
				}
			},
		});

		this.addCommand({
			id: "sign-in",
			name: "Sign in",
			checkCallback: (checking) => {
				if (this.settings.authMode !== "entra") return false;
				if (!checking) void this.signIn();
				return true;
			},
		});

		this.addCommand({
			id: "sign-out",
			name: "Sign out",
			callback: () => void this.signOut(),
		});
	}

	// ---------------------------------------------------------------- auth

	private createAuthProvider(mode: AuthMode): AuthProvider {
		switch (mode) {
			case "entra":
				return new EntraAuthProvider(
					this.entraConfig(),
					this.settings.entraSession ?? {},
					(session) => {
						this.settings.entraSession = session;
						// Deliberately not saveSettings(): that would recurse back into here.
						void this.saveData(this.settings);
					},
					(url) => {
						window.open(url, "_blank");
					},
				);
			case "azureCli":
				return new AzureCliAuthProvider(this.settings.azCliPath);
			default:
				return new PatAuthProvider(this.settings.pat);
		}
	}

	private entraConfig(): EntraConfig {
		return {
			clientId: this.settings.entraClientId,
			tenantId: this.settings.entraTenantId,
			redirectUri: this.settings.entraRedirectUri,
			scope: this.settings.entraScope,
		};
	}

	/** Push edited settings into the live provider, replacing it when the mode changes. */
	private syncAuthProvider(): void {
		if (this.auth.mode !== this.settings.authMode) {
			this.auth.dispose();
			this.auth = this.createAuthProvider(this.settings.authMode);
			return;
		}

		if (this.auth instanceof PatAuthProvider) this.auth.updatePat(this.settings.pat);
		else if (this.auth instanceof AzureCliAuthProvider)
			this.auth.updateBinaryPath(this.settings.azCliPath);
		else if (this.auth instanceof EntraAuthProvider) this.auth.updateConfig(this.entraConfig());
	}

	/**
	 * Listen for the browser handing the authorization code back.
	 *
	 * The default action is always registered so a mistyped redirect URI can be
	 * corrected without reloading the plugin.
	 */
	private registerProtocolCallback(): void {
		for (const action of new Set([
			DEFAULT_PROTOCOL_ACTION,
			protocolAction(this.settings.entraRedirectUri),
		])) {
			if (this.protocolActions.has(action)) continue;
			this.protocolActions.add(action);
			this.registerObsidianProtocolHandler(action, (params) => {
				if (this.auth instanceof EntraAuthProvider) {
					void this.auth.handleCallback(params);
				}
			});
		}
	}

	async signIn(): Promise<void> {
		if (!(this.auth instanceof EntraAuthProvider)) {
			new Notice("Select 'Microsoft Entra sign-in' in the plugin settings first.");
			return;
		}

		const provider = this.auth;
		this.registerProtocolCallback();

		try {
			// The authorize URL only exists after an await inside signIn(), so the
			// dialog is opened from the callback rather than read back synchronously.
			await provider.signIn(() => {
				const modal = new SignInModal(this.app, provider, () => provider.cancelSignIn());
				this.signInModal = modal;
				modal.open();
			});

			this.client.clearCaches();
			this.invalidateTypeInfo();
			this.refreshAllViews();
			const account = provider.status().account;
			new Notice(account ? `Signed in to Azure DevOps as ${account}.` : "Signed in to Azure DevOps.");
		} catch (error) {
			this.reportError(error, "Sign-in failed");
		} finally {
			this.signInModal?.closeSilently();
			this.signInModal = null;
		}
	}

	async signOut(): Promise<void> {
		await this.auth.signOut();
		if (this.settings.authMode === "pat" && this.settings.pat) {
			this.settings.pat = "";
			await this.saveSettings();
		}
		this.client.clearCaches();
		this.invalidateTypeInfo();
		this.refreshAllViews();
		new Notice("Signed out of Azure DevOps.");
	}

	forgetModal(modal: WorkItemSearchModal): void {
		this.openModals.delete(modal);
	}

	// -------------------------------------------------------------------- paste

	private registerPasteHandler(): void {
		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				(event: ClipboardEvent, editor: Editor) => {
					if (!this.settings.convertPastedLinks) return;
					if (event.defaultPrevented) return;

					const text = event.clipboardData?.getData("text/plain")?.trim();
					if (!text || /\s/.test(text) || !/_workitems/i.test(text)) return;

					const ref = parseWorkItemUrl(text);
					if (!ref || !this.isKnownOrganization(ref.organizationUrl)) return;

					const from = editor.getCursor("from");
					// Pasting a URL into a code block or frontmatter must stay literal.
					if (isLiteralContext(editor, from.line)) return;

					event.preventDefault();

					const placeholder = `[#${ref.id}](${formatUrl(text)})`;
					editor.replaceSelection(placeholder);
					void this.upgradePastedLink(editor, from, placeholder, ref.id);
				},
			),
		);
	}

	/** Replace the placeholder link with a full labelled reference once data arrives. */
	private async upgradePastedLink(
		editor: Editor,
		from: EditorPosition,
		placeholder: string,
		id: number,
	): Promise<void> {
		try {
			const item = await this.client.getWorkItem(id);
			if (!item) return;

			const to: EditorPosition = { line: from.line, ch: from.ch + placeholder.length };
			if (editor.getRange(from, to) !== placeholder) return; // The user edited it meanwhile.

			editor.replaceRange(this.buildWorkItemMarkdown(item), from, to);
		} catch (error) {
			this.logError(error);
		}
	}

	// --------------------------------------------------------------------- views

	registerEditorView(view: EditorView): void {
		this.editorViews.add(view);
	}

	unregisterEditorView(view: EditorView): void {
		this.editorViews.delete(view);
	}

	/** Force chips to re-render in every open markdown view. */
	refreshAllViews(): void {
		this.renderRevision++;

		for (const view of this.editorViews) {
			try {
				view.dispatch({ effects: refreshChipsEffect.of(null) });
			} catch (error) {
				this.logError(error);
			}
		}

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView) view.previewMode?.rerender(true);
		}
	}

	// -------------------------------------------------------------------- errors

	reportError(error: unknown, prefix = "Azure DevOps"): void {
		const message =
			error instanceof AzdoError
				? [error.message, error.hint].filter(Boolean).join(" ")
				: ((error as Error)?.message ?? String(error));
		new Notice(`${prefix}: ${message}`, 10000);
		this.logError(error);
	}

	/** Console logging plus a heavily throttled notice, so background failures stay quiet. */
	logError(error: unknown): void {
		console.error("[Azure DevOps work items]", error);
		const now = Date.now();
		if (error instanceof AzdoError && (error.status === 401 || error.status === 403)) {
			if (now - this.lastErrorNotice > 60_000) {
				this.lastErrorNotice = now;
				new Notice(`Azure DevOps: ${error.message} ${error.hint ?? ""}`.trim(), 10000);
			}
		}
	}
}

function escapeLinkLabel(label: string): string {
	return label
		.replace(/\\/g, "\\\\")
		.replace(/([[\]])/g, "\\$1")
		.replace(/\r?\n/g, " ");
}

function formatUrl(url: string): string {
	return /[()\s]/.test(url) ? `<${url}>` : url;
}

/**
 * Cheap check for fenced code blocks and YAML frontmatter above `line`.
 *
 * The paste handler has no access to the CodeMirror syntax tree, and this covers
 * the cases where silently rewriting a pasted URL would be destructive.
 */
function isLiteralContext(editor: Editor, line: number): boolean {
	let firstBodyLine = 0;

	// YAML frontmatter covers everything up to and including its closing marker.
	if (line > 0 && /^---\s*$/.test(editor.getLine(0))) {
		let closed = false;
		for (let current = 1; current <= line; current++) {
			if (/^(---|\.\.\.)\s*$/.test(editor.getLine(current))) {
				if (current >= line) return true;
				firstBodyLine = current + 1;
				closed = true;
				break;
			}
		}
		if (!closed) return true;
	}

	// An odd number of fences above the cursor means the cursor is inside a code block.
	let insideFence = false;
	for (let current = firstBodyLine; current < line; current++) {
		if (/^\s{0,3}(```|~~~)/.test(editor.getLine(current))) insideFence = !insideFence;
	}
	return insideFence;
}
