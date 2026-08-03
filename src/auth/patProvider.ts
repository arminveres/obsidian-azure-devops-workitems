import { AzdoError } from "../azdo/types";
import type { AuthProvider, AuthStatus } from "./types";

function toBase64(input: string): string {
	if (typeof btoa === "function") return btoa(input);
	return Buffer.from(input, "utf8").toString("base64");
}

/**
 * Classic personal access token auth.
 *
 * Azure DevOps expects HTTP basic auth with an empty username and the token as
 * the password. This is the only mode that works against Azure DevOps Server.
 */
export class PatAuthProvider implements AuthProvider {
	readonly mode = "pat" as const;
	/** A PAT never changes on its own, so retrying a 401 would just fail again. */
	readonly canRetryAfterUnauthorized = false;

	constructor(private pat: string) {}

	updatePat(pat: string): void {
		this.pat = pat;
	}

	get isConfigured(): boolean {
		return this.pat.trim().length > 0;
	}

	getAuthHeader(): Promise<string> {
		const token = this.pat.trim();
		if (!token) {
			return Promise.reject(
				new AzdoError(
					"No personal access token configured.",
					undefined,
					"Add a PAT with the 'Work items (read)' scope in the plugin settings.",
				),
			);
		}
		return Promise.resolve(`Basic ${toBase64(`:${token}`)}`);
	}

	invalidate(): void {
		// Nothing is cached.
	}

	status(): AuthStatus {
		return this.isConfigured
			? { ready: true, summary: "Using a personal access token." }
			: { ready: false, summary: "No personal access token set." };
	}

	async signOut(): Promise<void> {
		this.pat = "";
	}

	dispose(): void {
		// Nothing to release.
	}
}
