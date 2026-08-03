import { editorLivePreviewField } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, type EditorState, type Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import type AzdoPlugin from "../main";
import { createChipShell, fillChip } from "../chip";
import { findWorkItemLinks, labelToFallbackTitle } from "../reference";

/** Dispatch this to force every chip in an editor to re-render. */
export const refreshChipsEffect = StateEffect.define<null>();

/**
 * Node names that mean the markdown must stay literal. Escape nodes are
 * deliberately absent: `\[` inside a link label is normal, escaped content.
 */
const LITERAL_NODE = /(code|frontmatter|math)/i;

/**
 * True when the position sits inside code, a math span or frontmatter.
 *
 * Only ancestors are inspected — checking every descendant would reject a link
 * whose label merely contains an escape or other inline markup.
 */
function isInsideLiteral(state: EditorState, position: number): boolean {
	let node = syntaxTree(state).resolveInner(position, 1);
	for (;;) {
		if (LITERAL_NODE.test(node.name)) return true;
		const parent = node.parent;
		if (!parent) return false;
		node = parent;
	}
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((range) => range.to >= from && range.from <= to);
}

class WorkItemChipWidget extends WidgetType {
	constructor(
		private plugin: AzdoPlugin,
		readonly id: number,
		readonly url: string,
		readonly label: string,
		readonly project: string | undefined,
		private readonly revision: number,
	) {
		super();
	}

	eq(other: WorkItemChipWidget): boolean {
		return (
			other.id === this.id &&
			other.url === this.url &&
			other.label === this.label &&
			other.project === this.project &&
			other.revision === this.revision
		);
	}

	toDOM(): HTMLElement {
		const wrapper = document.createElement("span");
		wrapper.className = "azdo-chip-wrapper";

		const chip = createChipShell(wrapper, this.id, this.url);
		if (this.project) chip.dataset.azdoProject = this.project;

		const cached = this.plugin.client.workItems.peek(String(this.id));
		if (cached) {
			fillChip(
				chip,
				"loaded",
				this.plugin.chipOptions(),
				cached,
				this.plugin.getTypeInfo(cached.type, cached.project),
				this.label,
			);
		} else {
			fillChip(chip, "loading", this.plugin.chipOptions(), undefined, undefined, this.label);
		}

		void this.hydrate(chip);
		return wrapper;
	}

	private async hydrate(chip: HTMLAnchorElement): Promise<void> {
		try {
			const item = await this.plugin.client.getWorkItem(this.id);
			if (item) await this.plugin.ensureTypeInfo(item.project);
			if (!chip.isConnected) return;
			fillChip(
				chip,
				item ? "loaded" : "missing",
				this.plugin.chipOptions(),
				item,
				item ? this.plugin.getTypeInfo(item.type, item.project) : undefined,
				this.label,
			);
		} catch (error) {
			this.plugin.logError(error);
			if (!chip.isConnected) return;
			fillChip(chip, "error", this.plugin.chipOptions(), undefined, undefined, this.label);
		}
	}

	/** Let the chip's own anchor handle clicks instead of the editor. */
	ignoreEvent(): boolean {
		return true;
	}
}

export function createLivePreviewExtension(plugin: AzdoPlugin): Extension {
	class ChipViewPlugin implements PluginValue {
		decorations: DecorationSet;

		constructor(private view: EditorView) {
			plugin.registerEditorView(view);
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate): void {
			const forced = update.transactions.some((tr) =>
				tr.effects.some((effect) => effect.is(refreshChipsEffect)),
			);
			if (
				forced ||
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet ||
				// The markdown parser works incrementally, so a link can become (or stop
				// being) part of a code block after the document already settled.
				syntaxTree(update.state) !== syntaxTree(update.startState) ||
				update.state.field(editorLivePreviewField, false) !==
					update.startState.field(editorLivePreviewField, false)
			) {
				this.decorations = this.build(update.view);
			}
		}

		destroy(): void {
			plugin.unregisterEditorView(this.view);
		}

		private build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			if (!plugin.settings.renderInLivePreview) return builder.finish();
			// Without credentials nothing can be hydrated, so leave the plain link alone.
			if (!plugin.client.isConfigured) return builder.finish();
			if (!view.state.field(editorLivePreviewField, false)) return builder.finish();

			const doc = view.state.doc;
			let lastScannedLine = 0;

			// Scan whole lines: a reference never spans a line break, and visible
			// ranges can otherwise cut a link in half. Lines are visited in ascending
			// order, which is what RangeSetBuilder requires.
			for (const { from, to } of view.visibleRanges) {
				const firstLine = doc.lineAt(from).number;
				const lastLine = doc.lineAt(to).number;

				for (
					let lineNumber = Math.max(firstLine, lastScannedLine + 1);
					lineNumber <= lastLine;
					lineNumber++
				) {
					lastScannedLine = lineNumber;
					const line = doc.line(lineNumber);
					if (line.length === 0) continue;

					const matches = findWorkItemLinks(line.text, (organizationUrl) =>
						plugin.isKnownOrganization(organizationUrl),
					);

					for (const match of matches) {
						const start = line.from + match.from;
						const end = line.from + match.to;

						if (selectionTouches(view.state, start, end)) continue;
						if (isInsideLiteral(view.state, start)) continue;

						builder.add(
							start,
							end,
							Decoration.replace({
								widget: new WorkItemChipWidget(
									plugin,
									match.id,
									match.url,
									labelToFallbackTitle(match.label, match.id),
									match.project,
									plugin.renderRevision,
								),
							}),
						);
					}
				}
			}

			return builder.finish();
		}
	}

	return ViewPlugin.fromClass(ChipViewPlugin, {
		decorations: (value) => value.decorations,
	});
}
