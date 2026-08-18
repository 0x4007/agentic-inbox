import {
	GMAIL_READONLY_SCOPE,
	GMAIL_DRAFTS_SCOPE,
	hasGmailReadonlyScope,
	hasGmailDraftScope,
} from "./gmail-oauth";

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

export interface GmailThreadListPage {
	threads?: Array<{ id?: string; snippet?: string }>;
	nextPageToken?: string;
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
		let detail = "";
		try {
			const payload = await response.clone().json() as { error?: { message?: string } };
			detail = typeof payload.error?.message === "string" ? `: ${payload.error.message}` : "";
		} catch { /* non-JSON error */ }
		const status = response.status === 401 || response.status === 403
			? 401
			: 502;
		throw new GmailApiError(`Gmail API request failed (${response.status})${detail}`, status);
	}
	try {
		return await response.json() as T;
	} catch {
		throw new GmailApiError("Gmail returned an invalid API response", 502);
	}
}

function base64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createGmailDraft(input: { accessToken: string; to: string; subject: string; body: string; inReplyTo?: string | null; references?: string | null; fetcher?: Fetcher }): Promise<{ id: string }> {
	const headers = [`To: ${input.to}`, `Subject: ${input.subject}`, "Content-Type: text/html; charset=UTF-8", "MIME-Version: 1.0"];
	if (input.inReplyTo) headers.push(`In-Reply-To: <${input.inReplyTo}>`);
	if (input.references) headers.push(`References: ${input.references}`);
	const response = await (input.fetcher ?? fetch)(GMAIL_API_BASE_URL + "/drafts", {
		method: "POST", headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ message: { raw: base64Url(`${headers.join("\r\n")}\r\n\r\n${input.body}`) } }),
	});
	if (!response.ok) throw new GmailApiError(`Gmail draft create failed (${response.status})`, response.status === 401 || response.status === 403 ? 401 : 502);
	const result = await response.json() as { id?: string };
	if (!result.id) throw new GmailApiError("Gmail returned an invalid draft", 502);
	return { id: result.id };
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

export async function listGmailThreads(
	accessToken: string,
	input: { pageToken?: string; maxResults?: number; query?: string } = {},
	fetcher: Fetcher = fetch,
): Promise<GmailThreadListPage> {
	const params = new URLSearchParams({
		maxResults: String(Math.min(Math.max(input.maxResults ?? 100, 1), 100)),
		includeSpamTrash: "true",
		...(input.pageToken ? { pageToken: input.pageToken } : {}),
		...(input.query ? { q: input.query } : {}),
	});
	return gmailGet<GmailThreadListPage>("/threads?" + params.toString(), accessToken, fetcher);
}

export { GMAIL_READONLY_SCOPE };
