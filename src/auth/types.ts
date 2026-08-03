/** Azure DevOps' well-known Microsoft Entra application id. */
export const AZDO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/** Scope requested for delegated access to the Azure DevOps REST API. */
export const AZDO_SCOPE = `${AZDO_RESOURCE_ID}/.default`;

export type AuthMode = "pat" | "entra" | "azureCli";

export interface AuthStatus {
	/** Whether a request can currently be attempted. */
	ready: boolean;
	/** Short line shown in the settings tab. */
	summary: string;
	/** Signed-in account, when the provider knows it. */
	account?: string;
}

/**
 * Supplies the `Authorization` header for Azure DevOps requests.
 *
 * Implementations hide whether that is a static PAT or a short-lived bearer
 * token that has to be refreshed, so the REST client never deals with either.
 */
export interface AuthProvider {
	readonly mode: AuthMode;

	/** False when the user still has to supply credentials. */
	readonly isConfigured: boolean;

	/** Resolves the full header value, refreshing the token when necessary. */
	getAuthHeader(): Promise<string>;

	/**
	 * Drop any cached token so the next call re-acquires one.
	 * Called after a 401, since a token can be revoked before it expires.
	 */
	invalidate(): void;

	/** Whether a fresh credential can be obtained without user interaction. */
	readonly canRetryAfterUnauthorized: boolean;

	status(): AuthStatus;

	/** Forget stored credentials entirely. */
	signOut(): Promise<void>;

	dispose(): void;
}

/** Hint appended to auth failures, tailored to the active mode. */
export function unauthorizedHint(mode: AuthMode): string {
	switch (mode) {
		case "pat":
			return "Check that the personal access token is valid and has the 'Work items (read)' scope for this organization.";
		case "entra":
			return "Run 'Azure DevOps: Sign in' again — your session may have expired or been revoked.";
		case "azureCli":
			return "Run 'az login' in a terminal, then retry. Conditional Access may also require a fresh sign-in.";
	}
}
