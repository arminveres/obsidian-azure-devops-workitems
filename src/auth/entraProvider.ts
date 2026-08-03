import { requestUrl } from "obsidian";
import { AzdoError } from "../azdo/types";
import { createPkcePair, createState, formEncode } from "./pkce";
import { AZDO_SCOPE, type AuthProvider, type AuthStatus } from "./types";

const RENEW_MARGIN_MS = 5 * 60 * 1000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_REDIRECT_URI = "obsidian://azdo-auth";
export const DEFAULT_ENTRA_SCOPE = `${AZDO_SCOPE} offline_access`;
/** Works for any work or school account without pinning a directory. */
export const DEFAULT_TENANT = "organizations";

/** Always-available `obsidian://` action for the OAuth callback. */
export const DEFAULT_PROTOCOL_ACTION = "azdo-auth";

/** `obsidian://azdo-auth?code=…` → `azdo-auth`. */
export function protocolAction(redirectUri: string): string {
	const action = redirectUri
		.trim()
		.replace(/^obsidian:\/\//i, "")
		.split(/[?#]/)[0]
		.replace(/^\/+|\/+$/g, "");
	return action || DEFAULT_PROTOCOL_ACTION;
}

export interface EntraConfig {
	clientId: string;
	tenantId: string;
	redirectUri: string;
	scope: string;
}

/** The part of the session that survives a restart. */
export interface EntraSession {
	refreshToken?: string;
	account?: string;
	/** The registration the refresh token was issued for; it is useless under any other. */
	clientId?: string;
	tenantId?: string;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

interface PendingSignIn {
	state: string;
	verifier: string;
	url: string;
	/**
	 * The request parameters as they were when /authorize was called. Entra
	 * requires the token exchange to repeat them verbatim, so they must not be
	 * re-read from settings the user may have edited in the meantime.
	 */
	clientId: string;
	redirectUri: string;
	scope: string;
	resolve: () => void;
	reject: (error: unknown) => void;
	timer: number;
}

/**
 * OAuth 2.0 authorization code flow with PKCE against Microsoft Entra ID.
 *
 * This is the only mode that works on both desktop and mobile without a
 * personal access token. The browser returns to Obsidian through the
 * `obsidian://` protocol handler, so no loopback listener is needed.
 */
export class EntraAuthProvider implements AuthProvider {
	readonly mode = "entra" as const;
	/** A 401 may just mean the access token was revoked; refreshing can fix it. */
	readonly canRetryAfterUnauthorized = true;

	private accessToken: string | null = null;
	private expiresAt = 0;
	private refreshing: Promise<string> | null = null;
	private pending: PendingSignIn | null = null;

	constructor(
		private config: EntraConfig,
		private session: EntraSession,
		/** Persists the refresh token; the caller owns storage. */
		private onSessionChanged: (session: EntraSession) => void,
		/** Opens the system browser. */
		private openUrl: (url: string) => void,
	) {}

	get isConfigured(): boolean {
		return this.config.clientId.trim().length > 0;
	}

	get isSignedIn(): boolean {
		return Boolean(this.session.refreshToken) && this.sessionMatchesConfig();
	}

	/**
	 * A refresh token only works for the registration that issued it.
	 *
	 * This is checked on use rather than discarded on edit, so that typing in the
	 * client ID field — which fires a settings save per keystroke — cannot destroy
	 * a working session that the user then restores by undoing the edit.
	 */
	private sessionMatchesConfig(): boolean {
		// Sessions saved before this field existed are assumed to match.
		if (!this.session.clientId) return true;
		return (
			this.session.clientId === this.config.clientId.trim() &&
			(this.session.tenantId ?? "") === this.config.tenantId.trim()
		);
	}

	updateConfig(config: EntraConfig): void {
		const identityChanged =
			config.clientId.trim() !== this.config.clientId.trim() ||
			config.tenantId.trim() !== this.config.tenantId.trim();
		this.config = config;
		// The cached access token belongs to the old registration.
		if (identityChanged) this.invalidate();
	}

	// ------------------------------------------------------------------ tokens

	async getAuthHeader(): Promise<string> {
		if (!this.isConfigured) {
			throw new AzdoError(
				"No Microsoft Entra application (client) ID configured.",
				undefined,
				"Add the client ID of your app registration in the plugin settings.",
			);
		}

		if (this.accessToken && Date.now() < this.expiresAt - RENEW_MARGIN_MS) {
			return `Bearer ${this.accessToken}`;
		}

		if (!this.session.refreshToken) {
			throw new AzdoError(
				"Not signed in to Azure DevOps.",
				undefined,
				"Run the 'Azure DevOps: Sign in' command.",
			);
		}

		if (!this.sessionMatchesConfig()) {
			throw new AzdoError(
				"The saved sign-in belongs to a different app registration.",
				undefined,
				"Run the 'Azure DevOps: Sign in' command, or restore the previous application (client) ID.",
			);
		}

		this.refreshing ??= this.refresh(this.session.refreshToken).finally(() => {
			this.refreshing = null;
		});

		return `Bearer ${await this.refreshing}`;
	}

	private async refresh(refreshToken: string): Promise<string> {
		const body = formEncode({
			client_id: this.config.clientId.trim(),
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			scope: this.config.scope.trim() || DEFAULT_ENTRA_SCOPE,
		});

		const token = await this.postToken(body);
		if (!token.access_token) {
			// The refresh token is dead: force an interactive sign-in rather than looping.
			await this.signOut();
			throw new AzdoError(
				describeTokenError(token, "Your Azure DevOps session has expired."),
				undefined,
				"Run the 'Azure DevOps: Sign in' command to sign in again.",
			);
		}

		this.applyToken(token);
		return token.access_token;
	}

	private applyToken(token: TokenResponse): void {
		this.accessToken = token.access_token ?? null;
		this.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;

		// Entra rotates refresh tokens; dropping the new one would end the session.
		if (token.refresh_token) {
			this.session = {
				refreshToken: token.refresh_token,
				account: readAccountName(token.access_token) ?? this.session.account,
				clientId: this.config.clientId.trim(),
				tenantId: this.config.tenantId.trim(),
			};
			this.onSessionChanged(this.session);
		} else if (!this.session.account) {
			this.session = { ...this.session, account: readAccountName(token.access_token) };
			this.onSessionChanged(this.session);
		}
	}

	private async postToken(body: string): Promise<TokenResponse> {
		let response;
		try {
			response = await requestUrl({
				url: `${this.authority()}/oauth2/v2.0/token`,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
				throw: false,
			});
		} catch (error) {
			throw new AzdoError(
				`Could not reach Microsoft Entra ID: ${(error as Error).message}`,
				undefined,
				"Check your network connection.",
			);
		}

		try {
			return response.json as TokenResponse;
		} catch {
			throw new AzdoError(
				`Microsoft Entra ID returned an unreadable response (HTTP ${response.status}).`,
			);
		}
	}

	private authority(): string {
		const tenant = this.config.tenantId.trim() || DEFAULT_TENANT;
		return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`;
	}

	// ----------------------------------------------------------------- sign in

	/**
	 * Opens the browser and resolves once the protocol callback completes.
	 *
	 * `onReady` fires once the authorize URL exists, which is only after an
	 * `await`. Callers that want to show a dialog offering that URL must hook in
	 * here rather than reading {@link authorizeUrl} straight after calling this.
	 */
	async signIn(onReady?: (url: string) => void): Promise<void> {
		if (!this.isConfigured) {
			throw new AzdoError(
				"No Microsoft Entra application (client) ID configured.",
				undefined,
				"Add the client ID of your app registration in the plugin settings.",
			);
		}

		this.cancelPending("Sign-in restarted.");

		const { verifier, challenge } = await createPkcePair();
		const state = createState();
		const scope = this.config.scope.trim() || DEFAULT_ENTRA_SCOPE;
		const clientId = this.config.clientId.trim();
		const redirectUri = this.redirectUri();

		const query = formEncode({
			client_id: clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			response_mode: "query",
			scope,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			// Without this a silent SSO session can skip the account picker entirely.
			prompt: "select_account",
		});

		const url = `${this.authority()}/oauth2/v2.0/authorize?${query}`;

		const signIn = new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending = null;
				reject(new AzdoError("Timed out waiting for the browser sign-in to complete."));
			}, SIGN_IN_TIMEOUT_MS);
			this.pending = {
				state,
				verifier,
				url,
				clientId,
				redirectUri,
				scope,
				resolve,
				reject,
				timer,
			};
		});

		onReady?.(url);

		try {
			this.openUrl(url);
		} catch (error) {
			// Do not leave the caller waiting five minutes for a browser that never opened.
			if (this.pending) {
				this.settlePending(
					this.pending,
					new AzdoError(
						`Could not open the browser: ${(error as Error).message}`,
						undefined,
						"Copy the sign-in link from the dialog and open it manually.",
					),
				);
			}
		}

		return signIn;
	}

	/** The authorize URL of the sign-in currently in progress, for manual fallback. */
	get authorizeUrl(): string | null {
		return this.pending?.url ?? null;
	}

	/** Accepts a redirect URL pasted by hand when the browser cannot call back. */
	async submitRedirect(raw: string): Promise<void> {
		const query = raw.slice(raw.indexOf("?") + 1);
		if (!raw.includes("?") || !query) {
			throw new AzdoError("That does not look like a redirect URL — it has no query string.");
		}
		const params: Record<string, string> = {};
		for (const [key, value] of new URLSearchParams(query)) params[key] = value;
		await this.handleCallback(params);
	}

	private redirectUri(): string {
		return this.config.redirectUri.trim() || DEFAULT_REDIRECT_URI;
	}

	/** Called by the plugin's `obsidian://` protocol handler. */
	async handleCallback(params: Record<string, string>): Promise<void> {
		const pending = this.pending;
		if (!pending) return; // A stale callback, e.g. after a restart.

		if (params.state !== pending.state) {
			// Never redeem a code we did not ask for.
			this.settlePending(pending, new AzdoError("Sign-in response did not match the request."));
			return;
		}

		if (params.error) {
			this.settlePending(
				pending,
				new AzdoError(
					params.error_description?.split("\n")[0] || `Sign-in failed (${params.error}).`,
				),
			);
			return;
		}

		if (!params.code) {
			this.settlePending(pending, new AzdoError("Sign-in response did not contain a code."));
			return;
		}

		try {
			const token = await this.postToken(
				formEncode({
					client_id: pending.clientId,
					grant_type: "authorization_code",
					code: params.code,
					redirect_uri: pending.redirectUri,
					code_verifier: pending.verifier,
					scope: pending.scope,
				}),
			);

			if (!token.access_token) {
				throw new AzdoError(
					describeTokenError(token, "Microsoft Entra ID did not return an access token."),
					undefined,
					hintForTokenError(token),
				);
			}

			this.applyToken(token);
			this.settlePending(pending, null);
		} catch (error) {
			this.settlePending(pending, error);
		}
	}

	private settlePending(pending: PendingSignIn, error: unknown): void {
		window.clearTimeout(pending.timer);
		if (this.pending === pending) this.pending = null;
		if (error) pending.reject(error);
		else pending.resolve();
	}

	private cancelPending(reason: string): void {
		if (!this.pending) return;
		this.settlePending(this.pending, new AzdoError(reason));
	}

	/** Abandon an in-progress sign-in, e.g. when the user closes the dialog. */
	cancelSignIn(): void {
		this.cancelPending("Sign-in cancelled.");
	}

	// ------------------------------------------------------------------ status

	invalidate(): void {
		this.accessToken = null;
		this.expiresAt = 0;
	}

	status(): AuthStatus {
		if (!this.isConfigured) {
			return { ready: false, summary: "No application (client) ID set." };
		}
		if (!this.session.refreshToken) {
			return { ready: false, summary: "Not signed in." };
		}
		if (!this.sessionMatchesConfig()) {
			return {
				ready: false,
				summary: "The saved sign-in belongs to a different app registration — sign in again.",
			};
		}
		return {
			ready: true,
			summary: this.session.account
				? `Signed in as ${this.session.account}.`
				: "Signed in.",
			account: this.session.account,
		};
	}

	async signOut(): Promise<void> {
		this.invalidate();
		this.session = {};
		this.onSessionChanged(this.session);
	}

	dispose(): void {
		this.cancelPending("Plugin unloaded.");
		this.invalidate();
	}
}

function describeTokenError(token: TokenResponse, fallback: string): string {
	const description = token.error_description?.split("\n")[0]?.trim();
	if (description) return description;
	return token.error ? `${fallback} (${token.error})` : fallback;
}

function hintForTokenError(token: TokenResponse): string | undefined {
	const description = token.error_description ?? "";
	if (/AADSTS50011/.test(description)) {
		return "Add this exact redirect URI to the app registration under 'Mobile and desktop applications'.";
	}
	if (/AADSTS65001|consent/i.test(description)) {
		return "Grant the app the Azure DevOps 'user_impersonation' delegated permission.";
	}
	if (/AADSTS7000218|client_assertion|client_secret/.test(description)) {
		return "Set 'Allow public client flows' to Yes in the app registration.";
	}
	if (/AADSTS70011|scope/i.test(description)) {
		return "Try the scope 499b84ac-1321-427f-aa17-267ca6975798/user_impersonation offline_access instead.";
	}
	return undefined;
}

/**
 * Read the account name out of the access token for display only.
 *
 * The token is never trusted for authorization decisions here, so decoding
 * without signature validation is fine.
 */
function readAccountName(accessToken: string | undefined): string | undefined {
	if (!accessToken) return undefined;
	const payload = accessToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
		const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
		const claims = JSON.parse(json) as Record<string, unknown>;
		for (const key of ["upn", "preferred_username", "unique_name", "email"]) {
			const value = claims[key];
			if (typeof value === "string" && value) return value;
		}
	} catch {
		// Display only — a malformed token simply means no name.
	}
	return undefined;
}
