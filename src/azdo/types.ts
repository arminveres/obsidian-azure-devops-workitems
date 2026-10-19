/** Minimal shapes for the slice of the Azure DevOps REST API this plugin uses. */

export interface WorkItemIdentity {
	displayName?: string;
	uniqueName?: string;
	imageUrl?: string;
}

/** Raw work item as returned by `GET _apis/wit/workitems`. */
export interface RawWorkItem {
	id: number;
	rev?: number;
	url?: string;
	fields?: Record<string, unknown>;
	_links?: { html?: { href?: string } };
}

/** Normalised work item used everywhere in the plugin. */
export interface WorkItem {
	id: number;
	title: string;
	type: string;
	state: string;
	assignedTo?: string;
	assignedToImage?: string;
	iterationPath?: string;
	areaPath?: string;
	tags: string[];
	description?: string;
	project?: string;
	url: string;
	/** Epoch millis when this record was fetched. */
	fetchedAt: number;
}

export interface PullRequest {
	id: number;
	title: string;
	/** `active`, `completed` or `abandoned`. */
	status: string;
	isDraft: boolean;
	createdBy?: string;
	repository: string;
	project?: string;
	/** Branch names without the `refs/heads/` prefix. */
	sourceBranch: string;
	targetBranch: string;
	description?: string;
	reviewers: { name: string; vote: number }[];
	url: string;
	fetchedAt: number;
}

export interface WorkItemTypeState {
	name: string;
	color?: string;
	category?: string;
}

export interface WorkItemTypeInfo {
	name: string;
	referenceName?: string;
	color?: string;
	iconId?: string;
	iconUrl?: string;
	states: WorkItemTypeState[];
}

export interface AzdoProject {
	id: string;
	name: string;
}

export class AzdoError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly hint?: string,
		/** True when re-acquiring a credential could plausibly fix this. */
		readonly retryable = false,
	) {
		super(message);
		this.name = "AzdoError";
	}
}
