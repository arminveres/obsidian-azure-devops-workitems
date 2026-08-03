import { type App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import {
	DEFAULT_ENTRA_SCOPE,
	DEFAULT_REDIRECT_URI,
	DEFAULT_TENANT,
	type EntraSession,
} from "./auth/entraProvider";
import type { AuthMode } from "./auth/types";
import type AzdoPlugin from "./main";

export type EmptyQueryMode = "recent" | "assignedToMe" | "none";
export type SearchScope = "project" | "organization";

export interface AzdoSettings {
	organizationUrl: string;
	project: string;

	/** How the plugin authenticates to Azure DevOps. */
	authMode: AuthMode;
	pat: string;

	/** Microsoft Entra app registration used by the OAuth sign-in. */
	entraClientId: string;
	entraTenantId: string;
	entraRedirectUri: string;
	entraScope: string;
	/** Refresh token and account, written by the auth provider. */
	entraSession: EntraSession;

	/** Optional full path to the `az` executable. */
	azCliPath: string;

	/** Text that opens the work item picker, e.g. `az#`. */
	triggerPrefix: string;
	maxSuggestions: number;
	emptyQueryMode: EmptyQueryMode;
	searchScope: SearchScope;

	/**
	 * Markdown link label template.
	 * Placeholders: {id} {title} {type} {state} {typeAbbrev}
	 */
	linkLabelTemplate: string;

	renderInReadingView: boolean;
	renderInLivePreview: boolean;
	showTypeIcon: boolean;
	showState: boolean;
	showAssignee: boolean;
	showTitle: boolean;
	maxTitleLength: number;
	strikeThroughClosed: boolean;

	enableHoverPreview: boolean;
	convertPastedLinks: boolean;
	cacheTtlMinutes: number;
}

export const DEFAULT_SETTINGS: AzdoSettings = {
	organizationUrl: "",
	project: "",

	authMode: "pat",
	pat: "",

	entraClientId: "",
	entraTenantId: DEFAULT_TENANT,
	entraRedirectUri: DEFAULT_REDIRECT_URI,
	entraScope: DEFAULT_ENTRA_SCOPE,
	entraSession: {},

	azCliPath: "",

	triggerPrefix: "az#",
	maxSuggestions: 8,
	emptyQueryMode: "recent",
	searchScope: "project",

	linkLabelTemplate: "{typeAbbrev}#{id} {title}",

	renderInReadingView: true,
	renderInLivePreview: true,
	showTypeIcon: true,
	showState: true,
	showAssignee: false,
	showTitle: true,
	maxTitleLength: 80,
	strikeThroughClosed: true,

	enableHoverPreview: true,
	convertPastedLinks: true,
	cacheTtlMinutes: 30,
};

export class AzdoSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: AzdoPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ------------------------------------------------------------ connection
		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Organization URL")
			.setDesc(
				"For Azure DevOps Services use https://dev.azure.com/your-org. For Azure DevOps Server use https://server/tfs/YourCollection.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://dev.azure.com/contoso")
					.setValue(this.plugin.settings.organizationUrl)
					.onChange(async (value) => {
						this.plugin.settings.organizationUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Default project")
			.setDesc("Used when searching and when building links for new references.")
			.addText((text) =>
				text
					.setPlaceholder("MyProject")
					.setValue(this.plugin.settings.project)
					.onChange(async (value) => {
						this.plugin.settings.project = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		this.renderAuth(containerEl);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verifies the URL and credentials, and lists the projects you can see.")
			.addButton((button) =>
				button
					.setButtonText("Test")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true).setButtonText("Testing…");
						try {
							const { projects } = await this.plugin.client.testConnection();
							const names = projects.map((project) => project.name);
							const preview = names.slice(0, 5).join(", ");
							new Notice(
								`Connected. ${names.length} project(s) visible${
									preview ? `: ${preview}${names.length > 5 ? "…" : ""}` : ""
								}`,
								8000,
							);
						} catch (error) {
							this.plugin.reportError(error, "Connection failed");
						} finally {
							button.setDisabled(false).setButtonText("Test");
						}
					}),
			);

		// --------------------------------------------------------------- trigger
		new Setting(containerEl).setName("Autocomplete").setHeading();

		new Setting(containerEl)
			.setName("Trigger prefix")
			.setDesc(
				"Type this in the editor to open the work item picker. Avoid a bare '#', which collides with Obsidian tags.",
			)
			.addText((text) =>
				text
					.setPlaceholder("az#")
					.setValue(this.plugin.settings.triggerPrefix)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.triggerPrefix = trimmed.length > 0 ? trimmed : "az#";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum suggestions")
			.setDesc("How many work items to show in the picker.")
			.addSlider((slider) =>
				slider
					.setLimits(3, 25, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.maxSuggestions)
					.onChange(async (value) => {
						this.plugin.settings.maxSuggestions = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Search scope")
			.setDesc("Search only the default project, or the whole organization.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("project", "Default project")
					.addOption("organization", "Whole organization")
					.setValue(this.plugin.settings.searchScope)
					.onChange(async (value) => {
						this.plugin.settings.searchScope = value as SearchScope;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Before you type anything")
			.setDesc("What the picker shows right after the trigger, with an empty query.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("recent", "Recently changed work items")
					.addOption("assignedToMe", "Work items assigned to me")
					.addOption("none", "Nothing until I type")
					.setValue(this.plugin.settings.emptyQueryMode)
					.onChange(async (value) => {
						this.plugin.settings.emptyQueryMode = value as EmptyQueryMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Link label")
			.setDesc(
				"Markdown label written into the note. Placeholders: {id}, {title}, {type}, {typeAbbrev}, {state}.",
			)
			.addText((text) =>
				text
					.setPlaceholder("{typeAbbrev}#{id} {title}")
					.setValue(this.plugin.settings.linkLabelTemplate)
					.onChange(async (value) => {
						this.plugin.settings.linkLabelTemplate =
							value.trim() || DEFAULT_SETTINGS.linkLabelTemplate;
						await this.plugin.saveSettings();
					}),
			);

		// -------------------------------------------------------------- appearance
		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Rich chips in reading view")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.renderInReadingView)
					.onChange(async (value) => {
						this.plugin.settings.renderInReadingView = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Rich chips in live preview")
			.setDesc("Chips unfold back into plain markdown when the cursor moves into them.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.renderInLivePreview)
					.onChange(async (value) => {
						this.plugin.settings.renderInLivePreview = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show work item type icon")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTypeIcon).onChange(async (value) => {
					this.plugin.settings.showTypeIcon = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show title")
			.setDesc("Turn off for compact id-only chips.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTitle).onChange(async (value) => {
					this.plugin.settings.showTitle = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Show state").addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.showState).onChange(async (value) => {
				this.plugin.settings.showState = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Show assignee").addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.showAssignee).onChange(async (value) => {
				this.plugin.settings.showAssignee = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Strike through completed work items")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.strikeThroughClosed)
					.onChange(async (value) => {
						this.plugin.settings.strikeThroughClosed = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum title length")
			.setDesc("Longer titles are truncated inside the chip.")
			.addSlider((slider) =>
				slider
					.setLimits(20, 160, 5)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.maxTitleLength)
					.onChange(async (value) => {
						this.plugin.settings.maxTitleLength = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Hover preview")
			.setDesc("Show a details card when hovering a work item chip.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableHoverPreview)
					.onChange(async (value) => {
						this.plugin.settings.enableHoverPreview = value;
						await this.plugin.saveSettings();
					}),
			);

		// --------------------------------------------------------------- advanced
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Convert pasted work item URLs")
			.setDesc("Pasting an Azure DevOps work item URL inserts a reference instead.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.convertPastedLinks)
					.onChange(async (value) => {
						this.plugin.settings.convertPastedLinks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Cache lifetime (minutes)")
			.setDesc("How long work item details are reused before refetching.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 240, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.cacheTtlMinutes)
					.onChange(async (value) => {
						this.plugin.settings.cacheTtlMinutes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Clear cache")
			.setDesc("Forget every cached work item and refresh open notes.")
			.addButton((button) =>
				button.setButtonText("Clear").onClick(() => {
					this.plugin.client.clearCaches();
					this.plugin.refreshAllViews();
					new Notice("Azure DevOps cache cleared.");
				}),
			);
	}

	// ------------------------------------------------------------------- auth

	private renderAuth(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		const cloud = isAzureDevOpsServices(settings.organizationUrl);

		// Azure DevOps Server has no Entra or CLI support, so a stored cloud-only
		// mode would leave the dropdown showing one thing and the plugin using another.
		if (!cloud && settings.authMode !== "pat") {
			settings.authMode = "pat";
			void this.plugin.saveSettings();
		}
		// Keep an inherited desktop-only mode visible on mobile rather than
		// silently selecting something else behind the user's back.
		const showCli = cloud && (Platform.isDesktopApp || settings.authMode === "azureCli");

		new Setting(containerEl)
			.setName("Authentication")
			.setDesc(
				cloud
					? "Personal access tokens work everywhere. Microsoft Entra sign-in avoids storing a long-lived secret."
					: "This looks like Azure DevOps Server. Only personal access tokens are supported on-premises.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("pat", "Personal access token");
				if (cloud) dropdown.addOption("entra", "Microsoft Entra sign-in");
				if (showCli) dropdown.addOption("azureCli", "Azure CLI session");
				dropdown.setValue(settings.authMode).onChange(async (value) => {
					settings.authMode = value as AuthMode;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const status = this.plugin.auth.status();
		containerEl
			.createEl("p", { text: status.summary })
			.addClass(status.ready ? "azdo-setting-note" : "azdo-setting-warning");

		switch (settings.authMode) {
			case "pat":
				this.renderPatSettings(containerEl);
				break;
			case "entra":
				this.renderEntraSettings(containerEl);
				break;
			case "azureCli":
				this.renderCliSettings(containerEl);
				break;
		}
	}

	private renderPatSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"Needs the 'Work items (read)' scope. Stored in this vault's plugin data folder in plain text — treat the vault accordingly.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text
					.setPlaceholder("PAT")
					.setValue(this.plugin.settings.pat)
					.onChange(async (value) => {
						this.plugin.settings.pat = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}

	private renderEntraSettings(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("Application (client) ID")
			.setDesc(
				"From a Microsoft Entra app registration. See the README for the four settings it needs.",
			)
			.addText((text) =>
				text
					.setPlaceholder("00000000-0000-0000-0000-000000000000")
					.setValue(settings.entraClientId)
					.onChange(async (value) => {
						settings.entraClientId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Directory (tenant) ID")
			.setDesc(
				`Leave as '${DEFAULT_TENANT}' unless the app registration is single-tenant, in which case use the tenant GUID.`,
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_TENANT)
					.setValue(settings.entraTenantId)
					.onChange(async (value) => {
						settings.entraTenantId = value.trim() || DEFAULT_TENANT;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Redirect URI")
			.setDesc(
				"Register this under 'Mobile and desktop applications' in the app registration. Change it only if it collides with another plugin.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_REDIRECT_URI)
					.setValue(settings.entraRedirectUri)
					.onChange(async (value) => {
						settings.entraRedirectUri = value.trim() || DEFAULT_REDIRECT_URI;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Scope")
			.setDesc(
				"Only change this if sign-in fails with a scope error. The documented alternative ends in /user_impersonation instead of /.default.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_ENTRA_SCOPE)
					.setValue(settings.entraScope)
					.onChange(async (value) => {
						settings.entraScope = value.trim() || DEFAULT_ENTRA_SCOPE;
						await this.plugin.saveSettings();
					}),
			);

		const signedIn = Boolean(settings.entraSession.refreshToken);
		new Setting(containerEl)
			.setName(signedIn ? "Signed in" : "Sign in")
			.setDesc(
				signedIn
					? "Opens your browser again to sign in as a different account."
					: "Opens your browser to complete the Microsoft sign-in.",
			)
			.addButton((button) =>
				button
					.setButtonText(signedIn ? "Sign in again" : "Sign in")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true).setButtonText("Waiting for browser…");
						try {
							await this.plugin.signIn();
						} finally {
							this.display();
						}
					}),
			)
			.addExtraButton((button) =>
				button
					.setIcon("log-out")
					.setTooltip("Sign out")
					.setDisabled(!signedIn)
					.onClick(async () => {
						await this.plugin.signOut();
						this.display();
					}),
			);
	}

	private renderCliSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Azure CLI path")
			.setDesc(
				"Leave empty to search the usual install locations. Set a full path if the plugin cannot find `az`.",
			)
			.addText((text) =>
				text
					.setPlaceholder("/opt/homebrew/bin/az")
					.setValue(this.plugin.settings.azCliPath)
					.onChange(async (value) => {
						this.plugin.settings.azCliPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc("Discards the cached token so the next request asks the Azure CLI again.")
			.addButton((button) =>
				button.setButtonText("Refresh").onClick(async () => {
					this.plugin.auth.invalidate();
					try {
						await this.plugin.auth.getAuthHeader();
						new Notice("Got a token from the Azure CLI.");
					} catch (error) {
						this.plugin.reportError(error, "Azure CLI sign-in failed");
					}
					this.display();
				}),
			);
	}
}

/** Microsoft Entra sign-in exists only in the hosted service, not Azure DevOps Server. */
function isAzureDevOpsServices(organizationUrl: string): boolean {
	const url = organizationUrl.trim().toLowerCase();
	if (!url) return true;
	return url.includes("dev.azure.com") || url.includes(".visualstudio.com");
}
