import { setIcon } from "obsidian";
import type { WorkItem, WorkItemTypeInfo } from "./azdo/types";
import { resolveStateColor, resolveTypeColor, resolveTypeIcon } from "./chip";

function hexToCss(hex: string | undefined, fallback: string): string {
	if (!hex) return fallback;
	const clean = hex.replace(/^#/, "").slice(0, 6);
	return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : fallback;
}

/** One row in the autocomplete popup or the "insert work item" modal. */
export function renderSuggestionRow(
	container: HTMLElement,
	item: WorkItem,
	typeInfo?: WorkItemTypeInfo,
): void {
	const typeColor = hexToCss(resolveTypeColor(item.type, typeInfo), "var(--text-accent)");
	const stateColor = hexToCss(resolveStateColor(item.state, typeInfo), "var(--text-muted)");

	const icon = container.createDiv({ cls: "azdo-suggestion__icon" });
	icon.style.setProperty("--azdo-type-color", typeColor);
	setIcon(icon, resolveTypeIcon(item.type, typeInfo));
	if (icon.childElementCount === 0) {
		icon.createSpan({ cls: "azdo-chip__dot" });
	}

	const body = container.createDiv({ cls: "azdo-suggestion__body" });

	const titleRow = body.createDiv({ cls: "azdo-suggestion__title-row" });
	titleRow.createSpan({ cls: "azdo-suggestion__id", text: `#${item.id}` });
	titleRow.createSpan({ cls: "azdo-suggestion__title", text: item.title });

	const meta = body.createDiv({ cls: "azdo-suggestion__meta" });
	meta.createSpan({ cls: "azdo-suggestion__type", text: item.type });

	if (item.state) {
		const state = meta.createSpan({ cls: "azdo-suggestion__state" });
		state.style.setProperty("--azdo-state-color", stateColor);
		state.createSpan({ cls: "azdo-chip__dot" });
		state.createSpan({ text: item.state });
	}

	if (item.assignedTo) {
		meta.createSpan({ cls: "azdo-suggestion__assignee", text: item.assignedTo });
	}

	const iteration = item.iterationPath?.split("\\").pop();
	if (iteration) {
		meta.createSpan({ cls: "azdo-suggestion__iteration", text: iteration });
	}
}
