import {
	GMAIL_READONLY_SCOPE,
	hasGmailReadonlyScope,
} from "./gmail-oauth";

/**
 * The scope the stored credential must carry for the send transport to work.
 * Kept here (not imported) so gmail-client stays the single Gmail API surface.
 */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

export type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface GmailToken {
	accessToken: string;
	refreshToken?: string;
	scope?: string;
}

export interface GmailHeader {
	name?: string;
	value?: string;
}

export interface GmailMessagePart {
	mimeType?: string;
	headers?: GmailHeader[];
	body?: {
		data?: string;
		attachmentId?: string;
		size?: number;
	};
	parts?: GmailMessagePart[];
}

export interface GmailMessage {
	id?: string;
	threadId?: string;
	internalDate?: string;
	labelIds?: string[];
	payload?: GmailMessagePart;
	snippet?: string;
}

export interface GmailThread {
	id?: string;
	messages?: GmailMessage[];
}

export class GmailApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GmailApiError";
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value) {
		throw new GmailApiError("Gmail returned an invalid OAuth response", 502);
	}
	return value;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
	try {
		return asRecord(await response.json());
	} catch {
		return {};
	}
}

async function requestToken(
	params: URLSearchParams,
	fetcher: Fetcher,
): Promise<GmailToken> {
	let response: Response;
	try {
		response = await fetcher(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});
	} catch {
		throw new GmailApiError("Gmail OAuth token request failed", 502);
	}

	const payload = await jsonResponse(response);
	if (!response.ok) {
		throw new GmailApiError("Gmail OAuth token request failed", 502);
	}

	const scope = typeof payload.scope === "string" ? payload.scope : undefined;
	return {
		accessToken: requiredString(payload, "access_token"),
		refreshToken:
			typeof payload.refresh_token === "string"
				? payload.refresh_token
				: undefined,
		scope,
	};
}

export async function exchangeGmailAuthorizationCode(input: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	clientId: string;
	clientSecret: string;
	fetcher?: Fetcher;
}): Promise<GmailToken> {
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			code: input.code,
			code_verifier: input.codeVerifier,
			redirect_uri: input.redirectUri,
			client_id: input.clientId,
			client_secret: input.clientSecret,
		}),
		input.fetcher ?? fetch,
	);
	if (!token.refreshToken) {
		throw new GmailApiError("Gmail did not return an offline refresh credential", 502);
	}
	if (!hasGmailReadonlyScope(token.scope)) {
		throw new GmailApiError("Gmail did not grant the required read-only scope", 403);
	}
	return token;
}

export async function refreshGmailAccessToken(input: {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	storedScope: string;
	fetcher?: Fetcher;
}): Promise<string> {
	if (!hasGmailReadonlyScope(input.storedScope)) {
		throw new GmailApiError("Stored Gmail credentials lack the required read-only scope", 403);
	}
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: input.refreshToken,
			client_id: input.clientId,
			client_secret: input.clientSecret,
		}),
		input.fetcher ?? fetch,
	);
	if (token.scope && !hasGmailReadonlyScope(token.scope)) {
		throw new GmailApiError("Gmail no longer grants the required read-only scope", 403);
	}
	return token.accessToken;
}

async function gmailGet<T>(path: string, accessToken: string, fetcher: Fetcher): Promise<T> {
	let response: Response;
	try {
		response = await fetcher(GMAIL_API_BASE_URL + path, {
			headers: { Authorization: "Bearer " + accessToken },
		});
	} catch {
		throw new GmailApiError("Gmail API request failed", 502);
	}
	if (!response.ok) {
		const status = response.status === 401 || response.status === 403
			? 401
			: 502;
		throw new GmailApiError("Gmail API request failed", status);
	}
	try {
		return await response.json() as T;
	} catch {
		throw new GmailApiError("Gmail returned an invalid API response", 502);
	}
}

export async function getGmailProfile(
	accessToken: string,
	fetcher: Fetcher = fetch,
): Promise<{ accountEmail: string }> {
	const profile = await gmailGet<Record<string, unknown>>(
		"/profile",
		accessToken,
		fetcher,
	);
	const accountEmail = profile.emailAddress;
	if (typeof accountEmail !== "string" || !accountEmail.includes("@")) {
		throw new GmailApiError("Gmail did not return an account email", 502);
	}
	return { accountEmail: accountEmail.toLowerCase() };
}

export async function getGmailThread(
	gmailThreadId: string,
	accessToken: string,
	fetcher: Fetcher = fetch,
): Promise<GmailThread> {
	if (!/^[A-Za-z0-9_-]{1,255}$/.test(gmailThreadId)) {
		throw new GmailApiError("Invalid Gmail thread ID", 400);
	}
	return gmailGet<GmailThread>(
		"/threads/" + encodeURIComponent(gmailThreadId) + "?format=full",
		accessToken,
		fetcher,
	);
}

export interface GmailSendInput {
	/** Base64url-encoded RFC 2822 message. */
	raw: string;
	/** Optional Gmail thread ID to attach the message to. */
	threadId?: string;
}

/**
 * Send a message through the authenticated Gmail account (users.messages.send).
 * Gmail signs and delivers the message, so it always passes DMARC and is
 * placed in the account's Sent folder.
 */
export async function sendGmailMessage(
	accessToken: string,
	input: GmailSendInput,
	fetcher: Fetcher = fetch,
): Promise<{ id: string; threadId?: string }> {
	let response: Response;
	try {
		response = await fetcher(GMAIL_API_BASE_URL + "/messages/send", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + accessToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ raw: input.raw, threadId: input.threadId }),
		});
	} catch {
		throw new GmailApiError("Gmail API send request failed", 502);
	}
	if (!response.ok) {
		const status = response.status === 401 || response.status === 403
			? 401
			: response.status >= 400 && response.status < 500
				? 400
				: 502;
		throw new GmailApiError("Gmail API send request failed", status);
	}
	try {
		const payload = await response.json() as Record<string, unknown>;
		const id = typeof payload.id === "string" ? payload.id : "";
		if (!id) throw new GmailApiError("Gmail returned an invalid send response", 502);
		return {
			id,
			threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
		};
	} catch {
		throw new GmailApiError("Gmail returned an invalid send response", 502);
	}
}

export { GMAIL_READONLY_SCOPE };
