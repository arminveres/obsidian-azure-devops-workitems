import { type App, SuggestModal } from "obsidian";
import type AzdoPlugin from "./main";
import type { WorkItem } from "./azdo/types";
import { SearchDebouncer, type Suggestion } from "./searchDebouncer";
import { renderSuggestionRow } from "./suggestionRow";

/** Command palette driven work item picker. */
export class WorkItemSearchModal extends SuggestModal<Suggestion> {
	private debouncer: SearchDebouncer;

	constructor(
		app: App,
		private plugin: AzdoPlugin,
		private onChoose: (item: WorkItem) => void,
	) {
		super(app);
		this.setPlaceholder("Search Azure DevOps work items by id or title…");
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "insert reference" },
			{ command: "esc", purpose: "cancel" },
		]);
		this.modalEl.addClass("azdo-search-modal");

		this.debouncer = new SearchDebouncer(async (request) => {
			const items = await this.plugin.client.search({
				query: request.query,
				limit: request.limit,
				scope: this.plugin.settings.searchScope,
				// The modal is an explicit search, so always offer a starting point.
				emptyQueryMode:
					this.plugin.settings.emptyQueryMode === "none"
						? "recent"
						: this.plugin.settings.emptyQueryMode,
			});
			await this.plugin.warmTypeInfo(items);
			return items;
		});
	}

	async getSuggestions(query: string): Promise<Suggestion[]> {
		if (!this.plugin.client.isConfigured) {
			return [
				{
					kind: "message",
					text: "Azure DevOps is not configured",
					detail: "Add your organization URL and personal access token in the plugin settings.",
				},
			];
		}

		return this.debouncer.search({
			query,
			limit: Math.max(this.plugin.settings.maxSuggestions, 15),
		});
	}

	renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
		el.addClass("azdo-suggestion");
		if (suggestion.kind === "message") {
			el.addClass("azdo-suggestion--message");
			el.createDiv({ cls: "azdo-suggestion__message", text: suggestion.text });
			if (suggestion.detail) {
				el.createDiv({ cls: "azdo-suggestion__detail", text: suggestion.detail });
			}
			return;
		}
		renderSuggestionRow(
			el,
			suggestion.item,
			this.plugin.getTypeInfo(suggestion.item.type, suggestion.item.project),
		);
	}

	onChooseSuggestion(suggestion: Suggestion): void {
		if (suggestion.kind === "item") this.onChoose(suggestion.item);
	}

	onClose(): void {
		this.debouncer.dispose();
		this.plugin.forgetModal(this);
		super.onClose();
	}
}
