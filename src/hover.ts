import { setIcon } from "obsidian";
import type AzdoPlugin from "./main";
import type { PullRequest, WorkItem } from "./azdo/types";
import { applyIcon, pullRequestStyle, resolveStateColor, resolveTypeColor, resolveTypeIcon } from "./chip";

const OPEN_DELAY_MS = 320;
const CLOSE_DELAY_MS = 160;
/** Mirrors the width in `.azdo-hover-card`; used for viewport clamping. */
const CARD_WIDTH = 340;
const DESCRIPTION_LIMIT = 280;

function hexToCss(hex: string | undefined, fallback: string): string {
	if (!hex) return fallback;
	const clean = hex.replace(/^#/, "").slice(0, 6);
	return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : fallback;
}

/** Shows a details card when the pointer rests on a work item chip. */
export class HoverPreview {
	private card: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private openTimer: number | null = null;
	private closeTimer: number | null = null;
	private token = 0;

	constructor(private plugin: AzdoPlugin) {}

	register(): void {
		this.plugin.registerDomEvent(document, "mouseover", (event) => {
			if (!this.plugin.settings.enableHoverPreview) return;
			const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".azdo-chip");
			if (target) {
				this.scheduleOpen(target);
				return;
			}
			if ((event.target as HTMLElement | null)?.closest(".azdo-hover-card")) {
				this.cancelClose();
				return;
			}
			this.scheduleClose();
		});

		this.plugin.registerDomEvent(document, "mouseout", (event) => {
			const related = event.relatedTarget as HTMLElement | null;
			if (related?.closest(".azdo-hover-card") || related?.closest(".azdo-chip")) return;
			this.scheduleClose();
		});

		this.plugin.registerDomEvent(window, "scroll", () => this.hide(), true);
		this.plugin.registerDomEvent(document, "keydown", (event) => {
			if (event.key === "Escape") this.hide();
		});
	}

	private scheduleOpen(anchor: HTMLElement): void {
		this.cancelClose();
		if (this.anchor === anchor && this.card) return;
		if (this.openTimer !== null) window.clearTimeout(this.openTimer);

		this.openTimer = window.setTimeout(() => {
			this.openTimer = null;
			if (!anchor.isConnected) return;
			void this.show(anchor);
		}, OPEN_DELAY_MS);
	}

	private scheduleClose(): void {
		if (this.openTimer !== null) {
			window.clearTimeout(this.openTimer);
			this.openTimer = null;
		}
		if (!this.card || this.closeTimer !== null) return;
		this.closeTimer = window.setTimeout(() => {
			this.closeTimer = null;
			this.hide();
		}, CLOSE_DELAY_MS);
	}

	private cancelClose(): void {
		if (this.closeTimer !== null) {
			window.clearTimeout(this.closeTimer);
			this.closeTimer = null;
		}
	}

	private async show(anchor: HTMLElement): Promise<void> {
		const id = Number(anchor.dataset.azdoId);
		if (!Number.isFinite(id)) return;
		const isPr = anchor.dataset.azdoKind === "pr";
		const noun = isPr ? "pull request" : "work item";

		this.hide();
		const requestToken = ++this.token;
		this.anchor = anchor;

		const card = document.body.createDiv({ cls: "azdo-hover-card" });
		card.createDiv({ cls: "azdo-hover-card__loading", text: `Loading ${noun} ${id}…` });
		this.card = card;
		this.position(card, anchor);

		card.addEventListener("mouseenter", () => this.cancelClose());
		card.addEventListener("mouseleave", () => this.scheduleClose());

		try {
			const item = isPr
				? await this.plugin.client.getPullRequest(id)
				: await this.plugin.client.getWorkItem(id);
			if (item && !isPr) await this.plugin.ensureTypeInfo(item.project);
			// The chip may have been scrolled out of the DOM while loading.
			if (requestToken !== this.token || !card.isConnected || !anchor.isConnected) return;

			card.empty();
			if (item && "status" in item) this.renderPullRequestCard(card, item);
			else if (item) this.renderCard(card, item);
			else card.createDiv({ cls: "azdo-hover-card__loading", text: `${noun[0].toUpperCase()}${noun.slice(1)} ${id} is not accessible.` });
			this.position(card, anchor);
		} catch (error) {
			if (requestToken !== this.token || !card.isConnected) return;
			card.empty();
			card.createDiv({
				cls: "azdo-hover-card__loading",
				text: (error as Error).message || `Could not load ${noun}.`,
			});
		}
	}

	private renderPullRequestCard(card: HTMLElement, pr: PullRequest): void {
		const style = pullRequestStyle(pr);
		const color = hexToCss(style.color, "var(--text-accent)");

		const header = card.createDiv({ cls: "azdo-hover-card__header" });
		const icon = header.createSpan({ cls: "azdo-hover-card__icon" });
		icon.style.setProperty("--azdo-type-color", color);
		applyIcon(icon, style.icon, color);
		header.createSpan({ cls: "azdo-hover-card__type", text: "Pull request" });
		header.createSpan({ cls: "azdo-hover-card__id", text: `!${pr.id}` });
		const state = header.createSpan({ cls: "azdo-hover-card__state" });
		state.style.setProperty("--azdo-state-color", color);
		state.createSpan({ cls: "azdo-chip__dot" });
		state.createSpan({ text: style.label });

		card.createDiv({ cls: "azdo-hover-card__title", text: pr.title });

		const meta = card.createDiv({ cls: "azdo-hover-card__meta" });
		const addRow = (label: string, value?: string) => {
			if (!value) return;
			const row = meta.createDiv({ cls: "azdo-hover-card__row" });
			row.createSpan({ cls: "azdo-hover-card__label", text: label });
			row.createSpan({ cls: "azdo-hover-card__value", text: value });
		};
		addRow("Created by", pr.createdBy);
		addRow("Branches", `${pr.sourceBranch} → ${pr.targetBranch}`);
		addRow("Repository", pr.repository);
		addRow("Project", pr.project);
		// Votes: 10 approved, 5 approved with suggestions, -5 waiting, -10 rejected.
		const mark = (vote: number) => (vote >= 5 ? "✓" : vote === -5 ? "…" : vote <= -10 ? "✗" : "○");
		addRow("Reviewers", pr.reviewers.map((r) => `${mark(r.vote)} ${r.name}`).join(", "));

		if (pr.description) {
			const text =
				pr.description.length > DESCRIPTION_LIMIT
					? `${pr.description.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`
					: pr.description;
			card.createDiv({ cls: "azdo-hover-card__description", text });
		}

		const footer = card.createDiv({ cls: "azdo-hover-card__footer" });
		const link = footer.createEl("a", {
			cls: "azdo-hover-card__link",
			text: "Open in Azure DevOps",
			href: pr.url,
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			window.open(pr.url, "_blank");
			this.hide();
		});
	}

	private renderCard(card: HTMLElement, item: WorkItem): void {
		const typeInfo = this.plugin.getTypeInfo(item.type, item.project);
		const typeColor = hexToCss(resolveTypeColor(item.type, typeInfo), "var(--text-accent)");
		const stateColor = hexToCss(resolveStateColor(item.state, typeInfo), "var(--text-muted)");

		const header = card.createDiv({ cls: "azdo-hover-card__header" });
		const icon = header.createSpan({ cls: "azdo-hover-card__icon" });
		icon.style.setProperty("--azdo-type-color", typeColor);
		setIcon(icon, resolveTypeIcon(item.type, typeInfo));

		header.createSpan({ cls: "azdo-hover-card__type", text: item.type });
		header.createSpan({ cls: "azdo-hover-card__id", text: `#${item.id}` });

		if (item.state) {
			const state = header.createSpan({ cls: "azdo-hover-card__state" });
			state.style.setProperty("--azdo-state-color", stateColor);
			state.createSpan({ cls: "azdo-chip__dot" });
			state.createSpan({ text: item.state });
		}

		card.createDiv({ cls: "azdo-hover-card__title", text: item.title });

		const meta = card.createDiv({ cls: "azdo-hover-card__meta" });
		const addRow = (label: string, value?: string) => {
			if (!value) return;
			const row = meta.createDiv({ cls: "azdo-hover-card__row" });
			row.createSpan({ cls: "azdo-hover-card__label", text: label });
			row.createSpan({ cls: "azdo-hover-card__value", text: value });
		};

		addRow("Assigned to", item.assignedTo ?? "Unassigned");
		addRow("Iteration", item.iterationPath?.split("\\").pop());
		addRow("Area", item.areaPath?.split("\\").pop());
		addRow("Project", item.project);

		if (item.tags.length > 0) {
			const row = meta.createDiv({ cls: "azdo-hover-card__row" });
			row.createSpan({ cls: "azdo-hover-card__label", text: "Tags" });
			const tags = row.createSpan({ cls: "azdo-hover-card__tags" });
			for (const tag of item.tags) tags.createSpan({ cls: "azdo-hover-card__tag", text: tag });
		}

		if (item.description) {
			const text =
				item.description.length > DESCRIPTION_LIMIT
					? `${item.description.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`
					: item.description;
			card.createDiv({ cls: "azdo-hover-card__description", text });
		}

		const footer = card.createDiv({ cls: "azdo-hover-card__footer" });
		const link = footer.createEl("a", {
			cls: "azdo-hover-card__link",
			text: "Open in Azure DevOps",
			href: item.url,
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			window.open(item.url, "_blank");
			this.hide();
		});
	}

	private position(card: HTMLElement, anchor: HTMLElement): void {
		const rect = anchor.getBoundingClientRect();
		const cardRect = card.getBoundingClientRect();
		const margin = 8;

		let top = rect.bottom + margin;
		if (top + cardRect.height > window.innerHeight - margin) {
			const above = rect.top - cardRect.height - margin;
			top = above > margin ? above : Math.max(margin, window.innerHeight - cardRect.height - margin);
		}

		let left = rect.left;
		if (left + CARD_WIDTH > window.innerWidth - margin) {
			left = Math.max(margin, window.innerWidth - CARD_WIDTH - margin);
		}

		card.style.top = `${Math.round(top)}px`;
		card.style.left = `${Math.round(left)}px`;
	}

	hide(): void {
		this.token++;
		// A pending open must not fire after an explicit dismissal (scroll, Escape).
		if (this.openTimer !== null) {
			window.clearTimeout(this.openTimer);
			this.openTimer = null;
		}
		this.cancelClose();
		this.card?.remove();
		this.card = null;
		this.anchor = null;
	}

	destroy(): void {
		if (this.openTimer !== null) window.clearTimeout(this.openTimer);
		if (this.closeTimer !== null) window.clearTimeout(this.closeTimer);
		this.hide();
	}
}
