import {
	type App,
	Notice,
	Platform,
	PluginSettingTab,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
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

type SettingKey = keyof AzdoSettings;

/** Values that need trimming or a fallback before they reach the settings object. */
const NORMALISERS: Partial<Record<SettingKey, (value: string) => string>> = {
	organizationUrl: (value) => value.trim(),
	project: (value) => value.trim(),
	pat: (value) => value.trim(),
	azCliPath: (value) => value.trim(),
	entraClientId: (value) => value.trim(),
	entraTenantId: (value) => value.trim() || DEFAULT_TENANT,
	entraRedirectUri: (value) => value.trim() || DEFAULT_REDIRECT_URI,
	entraScope: (value) => value.trim() || DEFAULT_ENTRA_SCOPE,
	triggerPrefix: (value) => value.trim() || DEFAULT_SETTINGS.triggerPrefix,
	linkLabelTemplate: (value) => value.trim() || DEFAULT_SETTINGS.linkLabelTemplate,
};

export class AzdoSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: AzdoPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
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

		const authOptions: Record<string, string> = { pat: "Personal access token" };
		if (cloud) authOptions.entra = "Microsoft Entra sign-in";
		if (showCli) authOptions.azureCli = "Azure CLI session";

		return [
			{
				type: "group",
				heading: "Connection",
				items: [
					{
						name: "Organization URL",
						desc: "For Azure DevOps Services use https://dev.azure.com/your-org. For Azure DevOps Server use https://server/tfs/YourCollection.",
						control: {
							type: "text",
							key: "organizationUrl",
							placeholder: "https://dev.azure.com/contoso",
						},
					},
					{
						name: "Default project",
						desc: "Used when searching and when building links for new references.",
						control: { type: "text", key: "project", placeholder: "MyProject" },
					},
					{
						name: "Authentication",
						desc: cloud
							? "Personal access tokens work everywhere. Microsoft Entra sign-in avoids storing a long-lived secret."
							: "This looks like Azure DevOps Server. Only personal access tokens are supported on-premises.",
						control: { type: "dropdown", key: "authMode", options: authOptions },
					},
					{
						name: "Status",
						aliases: ["sign in", "signed in", "credential"],
						render: (setting) => {
							const status = this.plugin.auth.status();
							setting.setDesc(status.summary);
							// Rows are reused across updates, so set both states explicitly.
							setting.descEl.toggleClass("azdo-setting-note", status.ready);
							setting.descEl.toggleClass("azdo-setting-warning", !status.ready);
						},
					},
					...this.patItems(),
					...this.entraItems(),
					...this.cliItems(),
					{
						name: "Test connection",
						desc: "Verifies the URL and credentials, and lists the projects you can see.",
						render: (setting) => {
							setting.addButton((button) =>
								button
									.setButtonText("Test")
									.setCta()
									.onClick(async () => {
										button.setDisabled(true).setButtonText("Testing…");
										try {
											const { projects } =
												await this.plugin.client.testConnection();
											const names = projects.map((project) => project.name);
											const preview = names.slice(0, 5).join(", ");
											new Notice(
												`Connected. ${names.length} project(s) visible${
													preview
														? `: ${preview}${names.length > 5 ? "…" : ""}`
														: ""
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
						},
					},
				],
			},
			{
				type: "group",
				heading: "Autocomplete",
				items: [
					{
						name: "Trigger prefix",
						desc: "Type this in the editor to open the work item picker. Avoid a bare '#', which collides with Obsidian tags.",
						control: { type: "text", key: "triggerPrefix", placeholder: "az#" },
					},
					{
						name: "Maximum suggestions",
						desc: "How many work items to show in the picker.",
						control: { type: "slider", key: "maxSuggestions", min: 3, max: 25, step: 1 },
					},
					{
						name: "Search scope",
						desc: "Search only the default project, or the whole organization.",
						control: {
							type: "dropdown",
							key: "searchScope",
							options: {
								project: "Default project",
								organization: "Whole organization",
							},
						},
					},
					{
						name: "Before you type anything",
						desc: "What the picker shows right after the trigger, with an empty query.",
						control: {
							type: "dropdown",
							key: "emptyQueryMode",
							options: {
								recent: "Recently changed work items",
								assignedToMe: "Work items assigned to me",
								none: "Nothing until I type",
							},
						},
					},
					{
						name: "Link label",
						desc: "Markdown label written into the note. Placeholders: {id}, {title}, {type}, {typeAbbrev}, {state}.",
						control: {
							type: "text",
							key: "linkLabelTemplate",
							placeholder: DEFAULT_SETTINGS.linkLabelTemplate,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Rich chips in reading view",
						control: { type: "toggle", key: "renderInReadingView" },
					},
					{
						name: "Rich chips in live preview",
						desc: "Chips unfold back into plain Markdown when the cursor moves into them.",
						control: { type: "toggle", key: "renderInLivePreview" },
					},
					{
						name: "Show work item type icon",
						control: { type: "toggle", key: "showTypeIcon" },
					},
					{
						name: "Show title",
						desc: "Turn off for compact ID-only chips.",
						control: { type: "toggle", key: "showTitle" },
					},
					{ name: "Show state", control: { type: "toggle", key: "showState" } },
					{ name: "Show assignee", control: { type: "toggle", key: "showAssignee" } },
					{
						name: "Strike through completed work items",
						control: { type: "toggle", key: "strikeThroughClosed" },
					},
					{
						name: "Maximum title length",
						desc: "Longer titles are truncated inside the chip.",
						control: { type: "slider", key: "maxTitleLength", min: 20, max: 160, step: 5 },
					},
					{
						name: "Hover preview",
						desc: "Show a details card when hovering a work item chip.",
						control: { type: "toggle", key: "enableHoverPreview" },
					},
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						name: "Convert pasted work item URLs",
						desc: "Pasting an Azure DevOps work item URL inserts a reference instead.",
						control: { type: "toggle", key: "convertPastedLinks" },
					},
					{
						name: "Cache lifetime (minutes)",
						desc: "How long work item details are reused before refetching.",
						control: { type: "slider", key: "cacheTtlMinutes", min: 1, max: 240, step: 1 },
					},
					{
						name: "Clear cache",
						desc: "Forget every cached work item and refresh open notes.",
						render: (setting) => {
							setting.addButton((button) =>
								button.setButtonText("Clear").onClick(() => {
									this.plugin.client.clearCaches();
									this.plugin.refreshAllViews();
									new Notice("Azure DevOps cache cleared.");
								}),
							);
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as SettingKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		const normalise = NORMALISERS[key as SettingKey];
		settings[key] = normalise && typeof value === "string" ? normalise(value) : value;
		await this.plugin.saveSettings();
		// The credential fields and the status line follow the selected mode.
		if (key === "authMode") this.update();
	}

	// ------------------------------------------------------------------- auth

	private patItems(): SettingDefinition[] {
		return [
			{
				name: "Personal access token",
				desc: "Needs the 'Work items (read)' scope. Stored in this vault's plugin data folder in plain text — treat the vault accordingly.",
				visible: () => this.plugin.settings.authMode === "pat",
				// Rendered by hand so the input can be a password field.
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = "password";
						text.inputEl.autocomplete = "off";
						text
							.setPlaceholder("PAT")
							.setValue(this.plugin.settings.pat)
							.onChange((value) => void this.setControlValue("pat", value));
					});
				},
			},
		];
	}

	private entraItems(): SettingDefinition[] {
		const visible = (): boolean => this.plugin.settings.authMode === "entra";
		return [
			{
				name: "Application (client) ID",
				desc: "From a Microsoft Entra app registration. See the README for the four settings it needs.",
				visible,
				control: {
					type: "text",
					key: "entraClientId",
					placeholder: "00000000-0000-0000-0000-000000000000",
				},
			},
			{
				name: "Directory (tenant) ID",
				desc: `Leave as '${DEFAULT_TENANT}' unless the app registration is single-tenant, in which case use the tenant GUID.`,
				visible,
				control: { type: "text", key: "entraTenantId", placeholder: DEFAULT_TENANT },
			},
			{
				name: "Redirect URI",
				desc: "Register this under 'Mobile and desktop applications' in the app registration. Change it only if it collides with another plugin.",
				visible,
				control: {
					type: "text",
					key: "entraRedirectUri",
					placeholder: DEFAULT_REDIRECT_URI,
				},
			},
			{
				name: "Scope",
				desc: "Only change this if sign-in fails with a scope error. The documented alternative ends in /user_impersonation instead of /.default.",
				visible,
				control: { type: "text", key: "entraScope", placeholder: DEFAULT_ENTRA_SCOPE },
			},
			{
				name: "Sign in",
				desc: "Opens your browser to complete the Microsoft sign-in.",
				visible,
				render: (setting) => {
					const signedIn = Boolean(this.plugin.settings.entraSession.refreshToken);
					if (signedIn) {
						setting
							.setName("Signed in")
							.setDesc("Opens your browser again to sign in as a different account.");
					}
					setting
						.addButton((button) =>
							button
								.setButtonText(signedIn ? "Sign in again" : "Sign in")
								.setCta()
								.onClick(async () => {
									button.setDisabled(true).setButtonText("Waiting for browser…");
									try {
										await this.plugin.signIn();
									} finally {
										this.update();
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
									this.update();
								}),
						);
				},
			},
		];
	}

	private cliItems(): SettingDefinition[] {
		const visible = (): boolean => this.plugin.settings.authMode === "azureCli";
		return [
			{
				name: "Azure CLI path",
				desc: "Leave empty to search the usual install locations. Set a full path if the plugin cannot find `az`.",
				visible,
				control: { type: "text", key: "azCliPath", placeholder: "/opt/homebrew/bin/az" },
			},
			{
				name: "Refresh token",
				desc: "Discards the cached token so the next request asks the Azure CLI again.",
				visible,
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText("Refresh").onClick(async () => {
							this.plugin.auth.invalidate();
							try {
								await this.plugin.auth.getAuthHeader();
								new Notice("Got a token from the Azure CLI.");
							} catch (error) {
								this.plugin.reportError(error, "Azure CLI sign-in failed");
							}
							this.update();
						}),
					);
				},
			},
		];
	}
}

/** Microsoft Entra sign-in exists only in the hosted service, not Azure DevOps Server. */
function isAzureDevOpsServices(organizationUrl: string): boolean {
	const url = organizationUrl.trim().toLowerCase();
	if (!url) return true;
	return url.includes("dev.azure.com") || url.includes(".visualstudio.com");
}
