import type { MarkdownPostProcessor } from "obsidian";
import type AzdoPlugin from "../main";
import { createChipShell, fillChip, fillPullRequestChip } from "../chip";
import { labelToFallbackTitle, parseReference, type ReferenceKind } from "../reference";

interface Pending {
	chip: HTMLAnchorElement;
	id: number;
	kind: ReferenceKind;
	label: string;
}

/**
 * Reading view: swap Azure DevOps work item links for rich chips.
 * Every work item on the rendered chunk is fetched in one batched request.
 */
export function createWorkItemPostProcessor(plugin: AzdoPlugin): MarkdownPostProcessor {
	return (el: HTMLElement) => {
		if (!plugin.settings.renderInReadingView) return;
		// Without credentials nothing can be hydrated, so leave the plain link alone.
		if (!plugin.client.isConfigured) return;

		const anchors = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"));
		if (anchors.length === 0) return;

		const pending: Pending[] = [];

		for (const anchor of anchors) {
			if (anchor.closest("code, pre, .azdo-chip")) continue;

			const href = anchor.getAttribute("href") ?? "";
			const ref = parseReference(href);
			if (!ref || !plugin.isKnownOrganization(ref.organizationUrl)) continue;

			const label = labelToFallbackTitle(anchor.textContent ?? "", ref.id);

			const chip = createChipShell(createFragment(), ref.id, href);
			if (ref.project) chip.dataset.azdoProject = ref.project;
			if (ref.kind === "pr") {
				fillPullRequestChip(chip, "loading", plugin.chipOptions(), undefined, label);
			} else {
				fillChip(chip, "loading", plugin.chipOptions(), undefined, undefined, label);
			}

			anchor.replaceWith(chip);
			pending.push({ chip, id: ref.id, kind: ref.kind, label });
		}

		if (pending.length === 0) return;

		void hydrate(plugin, pending);
	};
}

async function hydrate(plugin: AzdoPlugin, pending: Pending[]): Promise<void> {
	await Promise.all([
		hydrateWorkItems(plugin, pending.filter((entry) => entry.kind === "workitem")),
		hydratePullRequests(plugin, pending.filter((entry) => entry.kind === "pr")),
	]);
}

async function hydratePullRequests(plugin: AzdoPlugin, pending: Pending[]): Promise<void> {
	await Promise.all(
		pending.map(async (entry) => {
			try {
				const pr = await plugin.client.getPullRequest(entry.id);
				fillPullRequestChip(entry.chip, pr ? "loaded" : "missing", plugin.chipOptions(), pr, entry.label);
			} catch (error) {
				plugin.logError(error);
				fillPullRequestChip(entry.chip, "error", plugin.chipOptions(), undefined, entry.label);
			}
		}),
	);
}

async function hydrateWorkItems(plugin: AzdoPlugin, pending: Pending[]): Promise<void> {
	if (pending.length === 0) return;
	const ids = [...new Set(pending.map((entry) => entry.id))];

	try {
		const items = await plugin.client.getWorkItems(ids);
		await plugin.warmTypeInfo([...items.values()]);

		for (const entry of pending) {
			const item = items.get(entry.id);
			fillChip(
				entry.chip,
				item ? "loaded" : "missing",
				plugin.chipOptions(),
				item,
				item ? plugin.getTypeInfo(item.type, item.project) : undefined,
				entry.label,
			);
		}
	} catch (error) {
		plugin.logError(error);
		for (const entry of pending) {
			fillChip(entry.chip, "error", plugin.chipOptions(), undefined, undefined, entry.label);
		}
	}
}
