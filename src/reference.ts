import { parseWorkItemUrl } from "./azdo/client";

export interface WorkItemLinkMatch {
	/** Offset of the first character of the whole link in the scanned text. */
	from: number;
	/** Offset just past the last character. */
	to: number;
	url: string;
	label: string;
	id: number;
	project?: string;
	/** True when the source was a bare URL rather than `[label](url)`. */
	bare: boolean;
}

/**
 * `[label](url)` where the label may contain escaped brackets (`\[`, `\]`), which is
 * exactly what this plugin writes for work item titles containing brackets.
 */
const MARKDOWN_LINK =
	/\[((?:[^[\]\\\n]|\\.)*)\]\(\s*(?:<([^<>\n]*)>|([^()\s]+))\s*(?:"[^"\n]*")?\s*\)/g;

/** A bare URL, optionally wrapped in angle brackets. */
const BARE_URL = /<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>()[\]]+)/g;

/** Punctuation that almost always belongs to the sentence, not to the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

function isWorkItemUrl(url: string): boolean {
	return /_workitems/i.test(url);
}

/** Undo the escaping applied when the label was written. */
function unescapeLabel(label: string): string {
	return label.replace(/\\([[\]\\])/g, "$1");
}

/**
 * Find every Azure DevOps work item reference in `text`.
 *
 * `accept` lets the caller ignore organizations the plugin is not configured for,
 * so unrelated Azure DevOps links keep their normal appearance.
 */
export function findWorkItemLinks(
	text: string,
	accept: (organizationUrl: string | undefined) => boolean,
): WorkItemLinkMatch[] {
	const matches: WorkItemLinkMatch[] = [];
	const consumed: [number, number][] = [];

	MARKDOWN_LINK.lastIndex = 0;
	for (let match = MARKDOWN_LINK.exec(text); match; match = MARKDOWN_LINK.exec(text)) {
		const [whole, label, angleUrl, plainUrl] = match;
		consumed.push([match.index, match.index + whole.length]);

		const url = angleUrl ?? plainUrl;
		if (!url || !isWorkItemUrl(url)) continue;

		const ref = parseWorkItemUrl(url);
		if (!ref || !accept(ref.organizationUrl)) continue;

		matches.push({
			from: match.index,
			to: match.index + whole.length,
			url,
			label: unescapeLabel(label),
			id: ref.id,
			project: ref.project,
			bare: false,
		});
	}

	BARE_URL.lastIndex = 0;
	for (let match = BARE_URL.exec(text); match; match = BARE_URL.exec(text)) {
		const start = match.index;
		let end = start + match[0].length;
		if (consumed.some(([from, to]) => start >= from && end <= to)) continue;

		const wrapped = match[1] !== undefined;
		let url = match[1] ?? match[2];

		if (!wrapped) {
			// `…/edit/1234.` at the end of a sentence must not swallow the full stop.
			const trimmed = url.replace(TRAILING_PUNCTUATION, "");
			end -= url.length - trimmed.length;
			url = trimmed;
		}

		if (!isWorkItemUrl(url)) continue;

		const ref = parseWorkItemUrl(url);
		if (!ref || !accept(ref.organizationUrl)) continue;

		matches.push({
			from: start,
			to: end,
			url,
			label: "",
			id: ref.id,
			project: ref.project,
			bare: true,
		});
	}

	return matches.sort((a, b) => a.from - b.from);
}

/**
 * Strip a generated label like `B#1234 Fix login` down to the title, so a chip
 * that fails to load still shows something meaningful.
 */
export function labelToFallbackTitle(label: string, id: number): string {
	const withoutId = label.replace(new RegExp(`^\\s*[A-Za-z]*#?${id}\\b[:\\-\\s]*`), "").trim();
	return withoutId || label.trim();
}

export function sameOrganization(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = organizationIdentity(a);
	const right = organizationIdentity(b);
	return left !== null && left === right;
}

/**
 * Canonical key for an organization so that the modern and legacy hosted URLs
 * (`dev.azure.com/contoso` and `contoso.visualstudio.com`) compare equal.
 */
export function organizationIdentity(rawUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		return null;
	}

	const host = url.hostname.toLowerCase();
	const segments = url.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment).toLowerCase();
			} catch {
				return segment.toLowerCase();
			}
		});

	if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) {
		return segments[0] ? `azdo:${segments[0]}` : null;
	}

	if (host.endsWith(".visualstudio.com")) {
		return `azdo:${host.slice(0, -".visualstudio.com".length)}`;
	}

	// On-premises: the host *including the port* plus the collection path identifies
	// the collection — two instances can share a hostname on different ports.
	return `tfs:${url.host.toLowerCase()}/${segments.join("/")}`.replace(/\/+$/, "");
}
