import { Platform } from "obsidian";
import { AzdoError } from "../azdo/types";
import { AZDO_RESOURCE_ID, type AuthProvider, type AuthStatus } from "./types";

/** Renew this long before expiry so a request never races the clock. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

/**
 * Locations to look in when `az` is not on PATH.
 *
 * Desktop apps launched from Finder or the Start menu inherit a minimal
 * environment, so a Homebrew or MSI install is frequently invisible.
 */
const AZ_CANDIDATES = [
	"/opt/homebrew/bin/az",
	"/usr/local/bin/az",
	"/usr/bin/az",
	"/snap/bin/az",
	"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
	"C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
];

/** Directories appended to PATH before invoking the CLI. */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];

interface CliToken {
	accessToken: string;
	tokenType?: string;
	/** Epoch seconds. Preferred: `expiresOn` carries no timezone. */
	expires_on?: number;
	expiresOn?: string;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	errno?: string;
}

/**
 * Reuses an existing `az login` session.
 *
 * Requires no Microsoft Entra app registration, which makes it the quickest
 * option on a workstation — but it shells out, so it is desktop only.
 */
export class AzureCliAuthProvider implements AuthProvider {
	readonly mode = "azureCli" as const;
	/** A refresh may well succeed: the CLI silently renews from its own cache. */
	readonly canRetryAfterUnauthorized = true;

	private token: string | null = null;
	private expiresAt = 0;
	private inFlight: Promise<string> | null = null;
	private lastAccount: string | undefined;

	constructor(private binaryPath: string) {}

	updateBinaryPath(binaryPath: string): void {
		if (binaryPath.trim() === this.binaryPath.trim()) return;
		this.binaryPath = binaryPath;
		this.invalidate();
	}

	get isConfigured(): boolean {
		return Platform.isDesktopApp;
	}

	async getAuthHeader(): Promise<string> {
		if (!Platform.isDesktopApp) {
			throw new AzdoError(
				"Azure CLI sign-in is not available on mobile.",
				undefined,
				"Switch to a personal access token or Microsoft Entra sign-in in the plugin settings.",
			);
		}

		if (this.token && Date.now() < this.expiresAt - RENEW_MARGIN_MS) {
			return `Bearer ${this.token}`;
		}

		// Collapse concurrent renderers onto a single CLI invocation.
		this.inFlight ??= this.acquire().finally(() => {
			this.inFlight = null;
		});

		return `Bearer ${await this.inFlight}`;
	}

	private async acquire(): Promise<string> {
		const result = await this.runAz([
			"account",
			"get-access-token",
			"--resource",
			AZDO_RESOURCE_ID,
			"-o",
			"json",
		]);

		if (result.errno === "ENOENT") {
			throw new AzdoError(
				"Could not find the Azure CLI (`az`).",
				undefined,
				"Install it, or set the full path to the az executable in the plugin settings.",
			);
		}

		if (result.code !== 0) {
			throw new AzdoError(this.explainCliFailure(result.stderr), undefined, this.hintFor(result.stderr));
		}

		let parsed: CliToken;
		try {
			parsed = JSON.parse(result.stdout) as CliToken;
		} catch {
			throw new AzdoError(
				"Could not read the token returned by the Azure CLI.",
				undefined,
				"Run `az account get-access-token` manually to see what it reports.",
			);
		}

		if (!parsed.accessToken) {
			throw new AzdoError("The Azure CLI returned an empty access token.");
		}

		this.token = parsed.accessToken;
		this.expiresAt = resolveExpiry(parsed);
		void this.refreshAccountName();
		return this.token;
	}

	/** Turn the CLI's stderr into one useful sentence. */
	private explainCliFailure(stderr: string): string {
		const aadsts = /AADSTS\d+: ([^\n.]+)/.exec(stderr);
		if (aadsts) return `Azure CLI could not get a token — ${aadsts[1].trim()}.`;
		if (/az login/i.test(stderr)) return "The Azure CLI is not signed in.";
		const firstLine = stderr.split("\n").find((line) => line.trim().length > 0);
		return firstLine?.replace(/^ERROR:\s*/, "").trim() || "The Azure CLI failed to return a token.";
	}

	private hintFor(stderr: string): string {
		if (/AADSTS50078|AADSTS50076/.test(stderr)) {
			return "Your tenant requires fresh multifactor authentication. Run: az login --scope 499b84ac-1321-427f-aa17-267ca6975798/.default";
		}
		if (/AADSTS530003/.test(stderr)) {
			return "Conditional Access requires a managed device for this resource. Use Microsoft Entra sign-in instead.";
		}
		return "Run `az login` in a terminal, then retry.";
	}

	/** Best effort: show which account the CLI is signed in as. */
	private async refreshAccountName(): Promise<void> {
		try {
			const result = await this.runAz(["account", "show", "--query", "user.name", "-o", "tsv"]);
			if (result.code === 0) this.lastAccount = result.stdout.trim() || undefined;
		} catch {
			// Purely cosmetic.
		}
	}

	private runAz(args: string[]): Promise<ExecResult> {
		// Required lazily: `child_process` does not exist in the mobile runtime.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { execFile } = require("child_process") as typeof import("child_process");
		const process_ = (globalThis as { process?: NodeJS.Process }).process;

		const configured = this.binaryPath.trim();
		const candidates = configured ? [configured] : ["az", ...AZ_CANDIDATES];

		const separator = process_?.platform === "win32" ? ";" : ":";
		const env = {
			...(process_?.env ?? {}),
			PATH: [process_?.env?.PATH, ...EXTRA_PATH].filter(Boolean).join(separator),
		};

		const attempt = (index: number): Promise<ExecResult> =>
			new Promise<ExecResult>((resolve) => {
				execFile(
					candidates[index],
					args,
					{ env, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
					(error, stdout, stderr) => {
						const errno = (error as NodeJS.ErrnoException | null)?.code;
						resolve({
							stdout: String(stdout ?? ""),
							stderr: String(stderr ?? ""),
							code: error ? ((error as { code?: number }).code ?? 1) : 0,
							errno: typeof errno === "string" ? errno : undefined,
						});
					},
				);
			}).then((result) => {
				// Only a missing binary is worth trying the next location for.
				if (result.errno === "ENOENT" && index + 1 < candidates.length) return attempt(index + 1);
				return result;
			});

		return attempt(0);
	}

	invalidate(): void {
		this.token = null;
		this.expiresAt = 0;
	}

	status(): AuthStatus {
		if (!Platform.isDesktopApp) {
			return { ready: false, summary: "Azure CLI sign-in is not available on mobile." };
		}
		if (this.token && Date.now() < this.expiresAt) {
			return {
				ready: true,
				summary: `Using the Azure CLI session, token valid until ${new Date(this.expiresAt).toLocaleTimeString()}.`,
				account: this.lastAccount,
			};
		}
		return { ready: true, summary: "Will request a token from the Azure CLI on first use." };
	}

	async signOut(): Promise<void> {
		this.invalidate();
		this.lastAccount = undefined;
	}

	dispose(): void {
		this.invalidate();
	}
}

function resolveExpiry(token: CliToken): number {
	if (typeof token.expires_on === "number" && Number.isFinite(token.expires_on)) {
		return token.expires_on * 1000;
	}
	// `expiresOn` has no timezone and is local time; only used as a fallback.
	const parsed = token.expiresOn ? Date.parse(token.expiresOn.replace(" ", "T")) : NaN;
	if (Number.isFinite(parsed)) return parsed;
	// Entra access tokens last an hour; assume the minimum rather than caching forever.
	return Date.now() + 30 * 60 * 1000;
}
