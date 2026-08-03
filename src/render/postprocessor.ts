import type { MarkdownPostProcessor } from "obsidian";
import type AzdoPlugin from "../main";
import { parseWorkItemUrl } from "../azdo/client";
import { createChipShell, fillChip } from "../chip";
import { labelToFallbackTitle } from "../reference";

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

		const pending: { chip: HTMLAnchorElement; id: number; label: string }[] = [];

		for (const anchor of anchors) {
			if (anchor.closest("code, pre, .azdo-chip")) continue;

			const href = anchor.getAttribute("href") ?? "";
			if (!/_workitems/i.test(href)) continue;

			const ref = parseWorkItemUrl(href);
			if (!ref || !plugin.isKnownOrganization(ref.organizationUrl)) continue;

			const label = labelToFallbackTitle(anchor.textContent ?? "", ref.id);

			const chip = createChipShell(createFragment(), ref.id, href);
			if (ref.project) chip.dataset.azdoProject = ref.project;
			fillChip(chip, "loading", plugin.chipOptions(), undefined, undefined, label);

			anchor.replaceWith(chip);
			pending.push({ chip, id: ref.id, label });
		}

		if (pending.length === 0) return;

		void hydrate(plugin, pending);
	};
}

async function hydrate(
	plugin: AzdoPlugin,
	pending: { chip: HTMLAnchorElement; id: number; label: string }[],
): Promise<void> {
	const ids = [...new Set(pending.map((entry) => entry.id))];

	try {
		const items = await plugin.client.getWorkItems(ids);
		await plugin.warmTypeInfo([...items.values()]);

		for (const entry of pending) {
			if (!entry.chip.isConnected) continue;
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
			if (!entry.chip.isConnected) continue;
			fillChip(entry.chip, "error", plugin.chipOptions(), undefined, undefined, entry.label);
		}
	}
}
