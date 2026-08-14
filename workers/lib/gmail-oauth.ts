const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const GMAIL_READONLY_SCOPE =
	"https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_AUTHORIZATION_URL =
	"https://accounts.google.com/o/oauth2/v2/auth";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ENCRYPTION_VERSION = "v1";

export interface GmailOAuthState {
	state: string;
	codeVerifier: string;
	redirectUri: string;
	returnPath: string;
	expiresAt: string;
}

export interface GmailAuthorization {
	authorizationUrl: string;
	oauthState: GmailOAuthState;
}

export class GmailOAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GmailOAuthError";
	}
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
	return encodeBase64Url(new Uint8Array(digest));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new GmailOAuthError("Gmail token encryption is not configured");
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
	return crypto.subtle.importKey(
		"raw",
		digest,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export function validateGmailReturnPath(
	returnPath: string | undefined,
	requestUrl: string,
): string {
	if (!returnPath) {
		throw new GmailOAuthError("A Gmail activation return path is required");
	}

	const request = new URL(requestUrl);
	const destination = new URL(returnPath, request.origin);
	if (
		destination.origin !== request.origin ||
		!destination.pathname.startsWith("/activate/gmail/") ||
		destination.pathname.length <= "/activate/gmail/".length
	) {
		throw new GmailOAuthError("Invalid Gmail activation return path");
	}

	return destination.pathname + destination.search;
}

export async function createGmailAuthorization(input: {
	clientId: string;
	redirectUri: string;
	returnPath: string;
	now?: Date;
}): Promise<GmailAuthorization> {
	if (!input.clientId) throw new GmailOAuthError("Gmail OAuth is not configured");
	const codeVerifier = randomBase64Url(64);
	const state = randomBase64Url(32);
	const now = input.now ?? new Date();
	const oauthState: GmailOAuthState = {
		state,
		codeVerifier,
		redirectUri: input.redirectUri,
		returnPath: input.returnPath,
		expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
	};

	const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
	authorizationUrl.search = new URLSearchParams({
		client_id: input.clientId,
		redirect_uri: input.redirectUri,
		response_type: "code",
		scope: GMAIL_READONLY_SCOPE,
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "false",
		state,
		code_challenge: await sha256Base64Url(codeVerifier),
		code_challenge_method: "S256",
	}).toString();

	return { authorizationUrl: authorizationUrl.toString(), oauthState };
}

export function hasGmailReadonlyScope(scope: string | undefined): boolean {
	return (scope ?? "").split(/\s+/).includes(GMAIL_READONLY_SCOPE);
}

export async function encryptRefreshToken(
	refreshToken: string,
	secret: string,
): Promise<string> {
	if (!refreshToken) throw new GmailOAuthError("Missing Gmail refresh token");
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await encryptionKey(secret),
		textEncoder.encode(refreshToken),
	);
	return [
		ENCRYPTION_VERSION,
		encodeBase64Url(iv),
		encodeBase64Url(new Uint8Array(encrypted)),
	].join(".");
}

export async function decryptRefreshToken(
	encryptedRefreshToken: string,
	secret: string,
): Promise<string> {
	const parts = encryptedRefreshToken.split(".");
	if (
		parts.length !== 3 ||
		parts[0] !== ENCRYPTION_VERSION ||
		!parts[1] ||
		!parts[2]
	) {
		throw new GmailOAuthError("Stored Gmail credentials are invalid");
	}

	try {
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: decodeBase64Url(parts[1]) },
			await encryptionKey(secret),
			decodeBase64Url(parts[2]),
		);
		return textDecoder.decode(decrypted);
	} catch {
		throw new GmailOAuthError("Stored Gmail credentials cannot be decrypted");
	}
}
