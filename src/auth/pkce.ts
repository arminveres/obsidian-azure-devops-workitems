/** Base64url encoding without padding, as required by RFC 7636. */
function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** Opaque value echoed back by the identity provider to bind a callback to its request. */
export function createState(): string {
	return base64Url(randomBytes(16));
}

export interface PkcePair {
	verifier: string;
	challenge: string;
}

/**
 * Create a PKCE verifier and its S256 challenge.
 *
 * 32 random bytes become a 43 character verifier, comfortably inside the
 * 43–128 character range the spec allows.
 */
export async function createPkcePair(): Promise<PkcePair> {
	const verifier = base64Url(randomBytes(32));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Form encoding for the token endpoint, which does not accept JSON. */
export function formEncode(values: Record<string, string | undefined>): string {
	return Object.entries(values)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
}
