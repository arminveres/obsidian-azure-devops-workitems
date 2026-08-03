import { Modal, Notice, Setting, type App } from "obsidian";
import type { EntraAuthProvider } from "./auth/entraProvider";

/**
 * Shown while the browser handles the Microsoft sign-in.
 *
 * Most of the time the `obsidian://` callback closes this by itself. The manual
 * paste box is there for the cases where it cannot: some Linux desktops never
 * hand the custom scheme back to Obsidian.
 */
export class SignInModal extends Modal {
	private closedByCaller = false;

	constructor(
		app: App,
		private provider: EntraAuthProvider,
		private onCancel: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Signing in to Azure DevOps");
		contentEl.createEl("p", {
			text: "Complete the sign-in in your browser. This dialog closes on its own when it succeeds.",
		});

		const url = this.provider.authorizeUrl;
		if (url) {
			new Setting(contentEl)
				.setName("Browser did not open?")
				.setDesc("Copy the sign-in link and open it yourself.")
				.addButton((button) =>
					button.setButtonText("Copy link").onClick(async () => {
						await navigator.clipboard.writeText(url);
						new Notice("Sign-in link copied.");
					}),
				)
				.addButton((button) =>
					button.setButtonText("Open again").setCta().onClick(() => {
						window.open(url, "_blank");
					}),
				);
		}

		let redirect = "";
		new Setting(contentEl)
			.setName("Stuck on a blank page?")
			.setDesc(
				"Paste the full obsidian:// address from your browser here. Only needed if the browser cannot hand control back to Obsidian.",
			)
			.addText((text) =>
				text
					.setPlaceholder("obsidian://azdo-auth?code=…")
					.onChange((value) => {
						redirect = value.trim();
					}),
			)
			.addButton((button) =>
				button.setButtonText("Submit").onClick(async () => {
					if (!redirect) return;
					try {
						await this.provider.submitRedirect(redirect);
					} catch (error) {
						new Notice((error as Error).message);
					}
				}),
			);
	}

	/** Close without treating it as the user giving up. */
	closeSilently(): void {
		this.closedByCaller = true;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.closedByCaller) this.onCancel();
	}
}
