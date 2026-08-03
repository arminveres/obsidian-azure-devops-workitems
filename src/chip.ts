import { setIcon } from "obsidian";
import type { WorkItem, WorkItemTypeInfo } from "./azdo/types";

/** Azure DevOps icon id -> Lucide icon shipped with Obsidian. */
const ICON_BY_AZDO_ID: Record<string, string> = {
	icon_insect: "bug",
	icon_clipboard: "clipboard-list",
	icon_book: "book-open",
	icon_crown: "crown",
	icon_trophy: "trophy",
	icon_chat_bubble: "message-square",
	icon_flame: "flame",
	icon_megaphone: "megaphone",
	icon_review: "eye",
	icon_test_plan: "clipboard-check",
	icon_test_suite: "folder",
	icon_test_case: "flask-conical",
	icon_test_beaker: "flask-conical",
	icon_check_box: "check-square",
	icon_list: "list",
	icon_key: "key",
	icon_diamond: "gem",
	icon_government: "landmark",
	icon_parachute: "life-buoy",
	icon_paint_brush: "paintbrush",
	icon_sticky_note: "sticky-note",
	icon_broken_lightbulb: "lightbulb",
	icon_github: "github",
	icon_traffic_cone: "cone",
	icon_gear: "settings",
	icon_headphone: "headphones",
	icon_gift: "gift",
	icon_car: "car",
	icon_airplane: "plane",
	icon_ribbon: "award",
	icon_gavel: "gavel",
	icon_pinwheel: "fan",
	icon_asterisk: "asterisk",
};

/** Fallback mapping by work item type name for processes without icon metadata. */
const ICON_BY_TYPE_NAME: Record<string, string> = {
	bug: "bug",
	task: "check-square",
	"user story": "book-open",
	"product backlog item": "list",
	feature: "trophy",
	epic: "crown",
	issue: "alert-circle",
	impediment: "shield",
	"test case": "flask-conical",
	"test plan": "clipboard-check",
	"test suite": "folder",
	requirement: "file-text",
	"change request": "git-pull-request",
	risk: "alert-triangle",
	review: "eye",
	"code review request": "git-pull-request",
	"shared steps": "list-checks",
	"shared parameter": "sliders-horizontal",
};

const COLOR_BY_TYPE_NAME: Record<string, string> = {
	bug: "CC293D",
	task: "F2CB1D",
	"user story": "009CCC",
	"product backlog item": "009CCC",
	feature: "773B93",
	epic: "FF7B00",
	issue: "B4009E",
	impediment: "B4009E",
	"test case": "004B50",
	requirement: "009CCC",
};

/** Colours used by Azure DevOps for each state category. */
const COLOR_BY_STATE_CATEGORY: Record<string, string> = {
	proposed: "B2B2B2",
	inprogress: "007ACC",
	resolved: "FF9D00",
	completed: "339947",
	removed: "E6E6E6",
};

const STATE_CATEGORY_BY_NAME: Record<string, string> = {
	new: "proposed",
	proposed: "proposed",
	"to do": "proposed",
	approved: "proposed",
	open: "proposed",
	active: "inprogress",
	committed: "inprogress",
	doing: "inprogress",
	"in progress": "inprogress",
	investigate: "inprogress",
	resolved: "resolved",
	closed: "completed",
	done: "completed",
	completed: "completed",
	removed: "removed",
};

const CLOSED_CATEGORIES = new Set(["completed", "removed"]);

export interface ChipDisplayOptions {
	showTypeIcon: boolean;
	showTitle: boolean;
	showState: boolean;
	showAssignee: boolean;
	maxTitleLength: number;
	strikeThroughClosed: boolean;
	/** Set the native `title` attribute — only useful when the hover card is off. */
	nativeTooltip: boolean;
}

export type ChipState = "loading" | "loaded" | "error" | "missing";

function normalise(value: string): string {
	return value.trim().toLowerCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const clean = hex.replace(/^#/, "");
	if (clean.length !== 6 && clean.length !== 8) return null;
	const value = Number.parseInt(clean.slice(0, 6), 16);
	if (Number.isNaN(value)) return null;
	return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function toCssColor(hex: string | undefined, fallback: string): string {
	if (!hex) return fallback;
	const rgb = hexToRgb(hex);
	return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : fallback;
}

function toCssColorAlpha(hex: string | undefined, alpha: number, fallback: string): string {
	if (!hex) return fallback;
	const rgb = hexToRgb(hex);
	return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : fallback;
}

export function resolveTypeColor(
	typeName: string,
	typeInfo?: WorkItemTypeInfo,
): string | undefined {
	return typeInfo?.color ?? COLOR_BY_TYPE_NAME[normalise(typeName)];
}

export function resolveTypeIcon(typeName: string, typeInfo?: WorkItemTypeInfo): string {
	const byId = typeInfo?.iconId ? ICON_BY_AZDO_ID[typeInfo.iconId] : undefined;
	return byId ?? ICON_BY_TYPE_NAME[normalise(typeName)] ?? "circle-dot";
}

export function resolveStateCategory(
	stateName: string,
	typeInfo?: WorkItemTypeInfo,
): string | undefined {
	const fromApi = typeInfo?.states.find(
		(state) => normalise(state.name) === normalise(stateName),
	)?.category;
	return normalise(fromApi ?? STATE_CATEGORY_BY_NAME[normalise(stateName)] ?? "");
}

export function resolveStateColor(
	stateName: string,
	typeInfo?: WorkItemTypeInfo,
): string | undefined {
	const fromApi = typeInfo?.states.find(
		(state) => normalise(state.name) === normalise(stateName),
	)?.color;
	if (fromApi) return fromApi;
	const category = resolveStateCategory(stateName, typeInfo);
	return category ? COLOR_BY_STATE_CATEGORY[category] : undefined;
}

/** Short form used by Azure DevOps-style references, e.g. Bug -> "B", User Story -> "US". */
export function typeAbbreviation(typeName: string): string {
	const words = typeName.split(/[\s_-]+/).filter(Boolean);
	if (words.length === 0) return "AB";
	if (words.length === 1) return words[0][0].toUpperCase();
	return words
		.map((word) => word[0])
		.join("")
		.toUpperCase();
}

function truncate(text: string, max: number): string {
	if (max <= 0 || text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function applyIcon(target: HTMLElement, iconName: string, color: string): void {
	target.empty();
	target.style.color = color;
	setIcon(target, iconName);
	if (target.childElementCount === 0) {
		// Unknown Lucide name: fall back to a coloured dot so the chip still reads well.
		const dot = target.createSpan({ cls: "azdo-chip__dot" });
		dot.style.backgroundColor = color;
	}
}

/** Creates the empty chip shell. Call {@link fillChip} once data is available. */
export function createChipShell(
	parent: HTMLElement | DocumentFragment,
	id: number,
	href: string,
): HTMLAnchorElement {
	const chip = parent.createEl("a", { cls: "azdo-chip azdo-chip--loading" });

	chip.setAttribute("href", href);
	chip.setAttribute("rel", "noopener");
	chip.dataset.azdoId = String(id);
	chip.dataset.azdoState = "loading";

	// Open in the system browser deterministically, in both reading and editing views.
	chip.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const target = chip.getAttribute("href");
		if (target) window.open(target, "_blank");
	});

	return chip;
}

/** Renders the chip contents for a given state. */
export function fillChip(
	chip: HTMLAnchorElement,
	state: ChipState,
	options: ChipDisplayOptions,
	item?: WorkItem | null,
	typeInfo?: WorkItemTypeInfo,
	fallbackLabel?: string,
): void {
	const id = chip.dataset.azdoId ?? "";
	chip.empty();
	chip.removeClasses([
		"azdo-chip--loading",
		"azdo-chip--error",
		"azdo-chip--missing",
		"azdo-chip--closed",
	]);
	chip.dataset.azdoState = state;

	if (state === "loading") {
		chip.addClass("azdo-chip--loading");
		chip.createSpan({ cls: "azdo-chip__spinner" });
		chip.createSpan({ cls: "azdo-chip__id", text: `#${id}` });
		if (fallbackLabel) {
			chip.createSpan({ cls: "azdo-chip__title", text: truncate(fallbackLabel, options.maxTitleLength) });
		}
		chip.setAttribute("aria-label", `Loading work item ${id}…`);
		return;
	}

	if (state === "error" || state === "missing" || !item) {
		chip.addClass(state === "missing" ? "azdo-chip--missing" : "azdo-chip--error");
		const icon = chip.createSpan({ cls: "azdo-chip__icon" });
		applyIcon(
			icon,
			state === "missing" ? "help-circle" : "alert-triangle",
			"var(--text-muted)",
		);
		chip.createSpan({ cls: "azdo-chip__id", text: `#${id}` });
		if (fallbackLabel) {
			chip.createSpan({
				cls: "azdo-chip__title",
				text: truncate(fallbackLabel, options.maxTitleLength),
			});
		}
		chip.setAttribute(
			"aria-label",
			state === "missing"
				? `Work item ${id} was not found or is not accessible`
				: `Could not load work item ${id}`,
		);
		return;
	}

	const typeColorHex = resolveTypeColor(item.type, typeInfo);
	const typeColor = toCssColor(typeColorHex, "var(--text-accent)");
	const stateColorHex = resolveStateColor(item.state, typeInfo);
	const stateColor = toCssColor(stateColorHex, "var(--text-muted)");
	const category = resolveStateCategory(item.state, typeInfo);

	chip.style.setProperty("--azdo-type-color", typeColor);
	chip.style.setProperty(
		"--azdo-type-color-soft",
		toCssColorAlpha(typeColorHex, 0.12, "var(--background-modifier-hover)"),
	);
	chip.style.setProperty("--azdo-state-color", stateColor);

	if (options.strikeThroughClosed && category && CLOSED_CATEGORIES.has(category)) {
		chip.addClass("azdo-chip--closed");
	}

	if (options.showTypeIcon) {
		const icon = chip.createSpan({ cls: "azdo-chip__icon" });
		applyIcon(icon, resolveTypeIcon(item.type, typeInfo), typeColor);
	}

	chip.createSpan({ cls: "azdo-chip__id", text: `#${item.id}` });

	if (options.showTitle) {
		chip.createSpan({
			cls: "azdo-chip__title",
			text: truncate(item.title, options.maxTitleLength),
		});
	}

	if (options.showState && item.state) {
		const stateEl = chip.createSpan({ cls: "azdo-chip__state" });
		stateEl.createSpan({ cls: "azdo-chip__state-dot" });
		stateEl.createSpan({ text: item.state });
	}

	if (options.showAssignee && item.assignedTo) {
		chip.createSpan({ cls: "azdo-chip__assignee", text: item.assignedTo });
	}

	chip.setAttribute(
		"aria-label",
		`${item.type} ${item.id}: ${item.title}${item.state ? ` (${item.state})` : ""}`,
	);
	if (options.nativeTooltip) {
		chip.setAttribute("title", `${item.type} ${item.id}: ${item.title}`);
	}
	chip.setAttribute("href", item.url);
}
