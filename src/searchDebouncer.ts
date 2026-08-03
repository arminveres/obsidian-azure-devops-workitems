import type { WorkItem } from "./azdo/types";
import { AzdoError } from "./azdo/types";

export type Suggestion =
	| { kind: "item"; item: WorkItem }
	| { kind: "message"; text: string; detail?: string };

export interface SearchRequest {
	query: string;
	limit: number;
}

/**
 * Debounces work item searches for the autocomplete and the picker modal.
 *
 * Every caller is guaranteed to be settled, and always with the results of the
 * newest query — a slow response for an older query can never overwrite a newer
 * one, which would otherwise make the popup flicker back to stale results.
 */
export class SearchDebouncer {
	private timer: number | null = null;
	private waiting: ((results: Suggestion[]) => void)[] = [];
	private generation = 0;
	private latest: SearchRequest = { query: "", limit: 0 };
	private disposed = false;

	constructor(
		private run: (request: SearchRequest) => Promise<WorkItem[]>,
		private delayMs = 260,
	) {}

	search(request: SearchRequest): Promise<Suggestion[]> {
		if (this.disposed) return Promise.resolve([]);

		this.generation++;
		this.latest = request;

		return new Promise<Suggestion[]>((resolve) => {
			this.waiting.push(resolve);
			this.restartTimer();
		});
	}

	private restartTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, this.delayMs);
	}

	private async flush(): Promise<void> {
		const generation = this.generation;
		const request = this.latest;
		const resolvers = this.waiting;
		this.waiting = [];

		if (resolvers.length === 0) return;

		let results: Suggestion[];
		try {
			const items = await this.run(request);
			results =
				items.length > 0
					? items.map((item) => ({ kind: "item" as const, item }))
					: [
							{
								kind: "message" as const,
								text:
									request.query.length > 0
										? `No work items match “${request.query}”`
										: "No work items to show",
							},
						];
		} catch (error) {
			results = [
				{
					kind: "message",
					text: error instanceof AzdoError ? error.message : "Could not reach Azure DevOps",
					detail: error instanceof AzdoError ? error.hint : undefined,
				},
			];
		}

		if (this.disposed) {
			for (const resolve of resolvers) resolve([]);
			return;
		}

		if (generation !== this.generation) {
			// A newer query arrived while this one was running. Hand these callers to
			// the pending run so they receive up-to-date results instead of stale ones.
			this.waiting.unshift(...resolvers);
			if (this.timer === null) this.restartTimer();
			return;
		}

		for (const resolve of resolvers) resolve(results);
	}

	/** Settle anything outstanding — safe to call more than once. */
	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		const resolvers = this.waiting;
		this.waiting = [];
		for (const resolve of resolvers) resolve([]);
	}
}
