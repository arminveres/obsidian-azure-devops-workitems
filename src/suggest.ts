import {
	type App,
	type Editor,
	type EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
} from "obsidian";
import type AzdoPlugin from "./main";
import { SearchDebouncer, type Suggestion } from "./searchDebouncer";
import { renderSuggestionRow } from "./suggestionRow";

export type { Suggestion } from "./searchDebouncer";

/** Stop searching once the text clearly turned into ordinary prose. */
const MAX_QUERY_LENGTH = 60;
const MAX_QUERY_WORDS = 4;

const NOT_CONFIGURED: Suggestion = {
	kind: "message",
	text: "Azure DevOps is not configured",
	detail: "Add your organization URL and personal access token in the plugin settings.",
};

export class WorkItemSuggest extends EditorSuggest<Suggestion> {
	private debouncer: SearchDebouncer;

	constructor(
		app: App,
		private plugin: AzdoPlugin,
	) {
		super(app);
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "insert reference" },
			{ command: "esc", purpose: "dismiss" },
		]);

		this.debouncer = new SearchDebouncer(async (request) => {
			const items = await this.plugin.client.search({
				query: request.query,
				limit: request.limit,
				scope: this.plugin.settings.searchScope,
				emptyQueryMode: this.plugin.settings.emptyQueryMode,
			});
			// Cached after the first call, so this only costs a round trip once.
			await this.plugin.warmTypeInfo(items);
			return items;
		});
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
	): EditorSuggestTriggerInfo | null {
		const prefix = this.plugin.settings.triggerPrefix;
		if (!prefix) return null;

		const line = editor.getLine(cursor.line);
		const beforeCursor = line.slice(0, cursor.ch);
		const start = beforeCursor.lastIndexOf(prefix);
		if (start === -1) return null;

		// The trigger must start a word, so `mail@az#` or `xaz#` do not fire it.
		const charBefore = start > 0 ? beforeCursor[start - 1] : "";
		if (charBefore && !/[\s([{<"'*_,;:]/.test(charBefore)) return null;

		const query = beforeCursor.slice(start + prefix.length);
		if (query.length > MAX_QUERY_LENGTH) return null;
		// Bail out on characters that mean the user is no longer picking a work item.
		if (/[\])`]/.test(query)) return null;
		if (query.startsWith(" ")) return null;
		if ((query.match(/ /g)?.length ?? 0) > MAX_QUERY_WORDS) return null;

		return {
			start: { line: cursor.line, ch: start },
			end: cursor,
			query,
		};
	}

	async getSuggestions(context: EditorSuggestContext): Promise<Suggestion[]> {
		if (!this.plugin.client.isConfigured) return [NOT_CONFIGURED];
		// Stay out of the way until the user actually types something.
		if (context.query.length === 0 && this.plugin.settings.emptyQueryMode === "none") return [];

		return this.debouncer.search({
			query: context.query,
			limit: this.plugin.settings.maxSuggestions,
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

	selectSuggestion(suggestion: Suggestion): void {
		const context = this.context;
		if (!context) return;

		if (suggestion.kind === "message") {
			this.close();
			return;
		}

		const markdown = this.plugin.buildWorkItemMarkdown(suggestion.item);
		context.editor.replaceRange(markdown, context.start, context.end);
		context.editor.setCursor({
			line: context.start.line,
			ch: context.start.ch + markdown.length,
		});
		this.close();
	}

	/** Called from the plugin's onunload to drop any pending debounce. */
	dispose(): void {
		this.debouncer.dispose();
	}
}
