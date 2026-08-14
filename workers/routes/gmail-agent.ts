import type { Context } from "hono";
import type { MailboxDO } from "../durableObject";
import {
	GmailApiError,
	exchangeGmailAuthorizationCode,
	getGmailProfile,
	getGmailThread,
	refreshGmailAccessToken,
} from "../lib/gmail-client";
import {
	GmailImportError,
	importGmailThread,
	type GmailImportStore,
} from "../lib/gmail-import";
import {
	GmailOAuthError,
	createGmailAuthorization,
	decryptRefreshToken,
	encryptRefreshToken,
	validateGmailReturnPath,
} from "../lib/gmail-oauth";
import type { Env } from "../types";

export type AgentContext = Context<{ Bindings: Env }>;

const LOGICAL_MAILBOX_ID = "pavlovcik.com";
const GMAIL_CREDENTIAL_ID = "primary";

type GmailMailbox = Pick<
	MailboxDO,
	| "getGmailCredentials"
	| "getGmailCredentialsForUse"
	| "saveGmailCredentials"
	| "saveGmailOAuthState"
	| "consumeGmailOAuthState"
	| "getThreadAutomation"
	| "upsertThreadAutomation"
	| "findEmailByIdentity"
	| "createEmail"
>;

interface GmailConfiguration {
	clientId: string;
	clientSecret: string;
	tokenEncryptionKey: string;
}

function mailbox(c: AgentContext): GmailMailbox {
	return c.env.MAILBOX.get(
		c.env.MAILBOX.idFromName(LOGICAL_MAILBOX_ID),
	) as unknown as GmailMailbox;
}

function gmailConfiguration(c: AgentContext): GmailConfiguration | null {
	const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_TOKEN_ENCRYPTION_KEY } =
		c.env;
	if (
		!GMAIL_CLIENT_ID ||
		!GMAIL_CLIENT_SECRET ||
		!GMAIL_TOKEN_ENCRYPTION_KEY
	) {
		return null;
	}
	return {
		clientId: GMAIL_CLIENT_ID,
		clientSecret: GMAIL_CLIENT_SECRET,
		tokenEncryptionKey: GMAIL_TOKEN_ENCRYPTION_KEY,
	};
}

function stringField(row: unknown, key: string): string | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) return null;
	const value = (row as Record<string, unknown>)[key];
	return typeof value === "string" && value ? value : null;
}

function booleanField(row: unknown, key: string, fallback: boolean): boolean {
	if (!row || typeof row !== "object" || Array.isArray(row)) return fallback;
	const value = (row as Record<string, unknown>)[key];
	return value === true || value === 1 || value === "1";
}

function automationMode(row: unknown): "draft" | "auto" {
	return stringField(row, "mode") === "auto" ? "auto" : "draft";
}

function responseForGmailError(c: AgentContext, error: unknown) {
	if (error instanceof GmailImportError) {
		return c.json({ error: error.message }, error.status === 409 ? 409 : 502);
	}
	if (error instanceof GmailApiError) {
		if (error.status === 400) return c.json({ error: error.message }, 400);
		if (error.status === 401) {
			return c.json({ error: "Gmail authorization must be reconnected" }, 401);
		}
		if (error.status === 403) return c.json({ error: error.message }, 403);
		return c.json({ error: error.message }, 502);
	}
	if (error instanceof GmailOAuthError) {
		return c.json({ error: error.message }, 503);
	}
	return c.json({ error: "Gmail request failed" }, 502);
}

async function retainGmailThreadIdentity(
	stub: GmailMailbox,
	threadId: string,
	gmailThreadId: string,
): Promise<void> {
	const current = await stub.getThreadAutomation(threadId);
	const currentGmailThreadId = stringField(current, "gmail_thread_id");
	if (currentGmailThreadId && currentGmailThreadId !== gmailThreadId) {
		throw new GmailImportError(
			"Local thread already belongs to another Gmail thread",
			409,
		);
	}

	await stub.upsertThreadAutomation({
		threadId,
		gmailThreadId,
		enabled: booleanField(current, "enabled", false),
		mode: automationMode(current),
		goalPrompt: stringField(current, "goal_prompt") ?? "",
		privateNotes: stringField(current, "private_notes") ?? "",
	});
}

export async function gmailStatus(c: AgentContext) {
	const credentials = await mailbox(c).getGmailCredentials(GMAIL_CREDENTIAL_ID);
	const accountEmail = stringField(credentials, "account_email");
	return c.json({
		connected: Boolean(accountEmail),
		accountEmail,
	});
}

export async function gmailOAuthStart(c: AgentContext) {
	const configuration = gmailConfiguration(c);
	if (!configuration) {
		return c.json({ error: "Gmail OAuth is not configured" }, 503);
	}

	let returnPath: string;
	try {
		returnPath = validateGmailReturnPath(
			c.req.query("returnPath"),
			c.req.url,
		);
	} catch (error) {
		return c.json(
			{
				error:
					error instanceof GmailOAuthError
						? error.message
						: "Invalid Gmail activation return path",
			},
			400,
		);
	}

	const redirectUri = new URL(
		"/api/v1/gmail/oauth/callback",
		c.req.url,
	).toString();
	try {
		const authorization = await createGmailAuthorization({
			clientId: configuration.clientId,
			redirectUri,
			returnPath,
		});
		await mailbox(c).saveGmailOAuthState(authorization.oauthState);
		return c.redirect(authorization.authorizationUrl, 302);
	} catch (error) {
		return responseForGmailError(c, error);
	}
}

export async function gmailOAuthCallback(c: AgentContext) {
	const state = c.req.query("state");
	if (!state) return c.json({ error: "Missing OAuth state" }, 400);

	const storedState = await mailbox(c).consumeGmailOAuthState(state);
	if (!storedState) {
		return c.json({ error: "OAuth state is invalid or expired" }, 400);
	}

	if (c.req.query("error")) {
		return c.json({ error: "Gmail authorization was not completed" }, 400);
	}

	const code = c.req.query("code");
	if (!code) return c.json({ error: "Missing Gmail authorization code" }, 400);

	const configuration = gmailConfiguration(c);
	if (!configuration) {
		return c.json({ error: "Gmail OAuth is not configured" }, 503);
	}

	const codeVerifier = stringField(storedState, "code_verifier");
	const redirectUri = stringField(storedState, "redirect_uri");
	const storedReturnPath = stringField(storedState, "return_path");
	if (!codeVerifier || !redirectUri || !storedReturnPath) {
		return c.json({ error: "Stored OAuth state is invalid" }, 400);
	}

	let returnPath: string;
	try {
		returnPath = validateGmailReturnPath(storedReturnPath, c.req.url);
	} catch {
		return c.json({ error: "Stored OAuth return path is invalid" }, 400);
	}

	try {
		const token = await exchangeGmailAuthorizationCode({
			code,
			codeVerifier,
			redirectUri,
			clientId: configuration.clientId,
			clientSecret: configuration.clientSecret,
		});
		const profile = await getGmailProfile(token.accessToken);
		const encryptedRefreshToken = await encryptRefreshToken(
			token.refreshToken ?? "",
			configuration.tokenEncryptionKey,
		);
		await mailbox(c).saveGmailCredentials({
			id: GMAIL_CREDENTIAL_ID,
			accountEmail: profile.accountEmail,
			encryptedRefreshToken,
			scope: token.scope ?? "",
		});
		return c.redirect(returnPath, 302);
	} catch (error) {
		return responseForGmailError(c, error);
	}
}

export async function gmailImport(c: AgentContext) {
	const configuration = gmailConfiguration(c);
	if (!configuration) {
		return c.json({ error: "Gmail OAuth is not configured" }, 503);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Expected a JSON request body" }, 400);
	}
	const requestBody =
		body &&
		typeof body === "object" &&
		!Array.isArray(body)
			? body as Record<string, unknown>
			: null;
	const requestedGmailThreadId = requestBody?.gmailThreadId;
	const gmailThreadId =
		typeof requestedGmailThreadId === "string" ? requestedGmailThreadId : "";
	if (!/^[A-Za-z0-9_-]{1,255}$/.test(gmailThreadId)) {
		return c.json({ error: "Invalid Gmail thread ID" }, 400);
	}

	const stub = mailbox(c);
	const credentials = await stub.getGmailCredentialsForUse(GMAIL_CREDENTIAL_ID);
	const encryptedRefreshToken = stringField(
		credentials,
		"encrypted_refresh_token",
	);
	const scope = stringField(credentials, "scope");
	if (!encryptedRefreshToken || !scope) {
		return c.json({ error: "Gmail is not connected" }, 409);
	}

	try {
		const refreshToken = await decryptRefreshToken(
			encryptedRefreshToken,
			configuration.tokenEncryptionKey,
		);
		const accessToken = await refreshGmailAccessToken({
			refreshToken,
			clientId: configuration.clientId,
			clientSecret: configuration.clientSecret,
			storedScope: scope,
		});
		const thread = await getGmailThread(gmailThreadId, accessToken);
		const result = await importGmailThread({
			gmailThreadId,
			thread,
			store: stub as unknown as GmailImportStore,
		});
		await retainGmailThreadIdentity(stub, result.threadId, gmailThreadId);
		return c.json({ threadId: result.threadId });
	} catch (error) {
		return responseForGmailError(c, error);
	}
}

// React Router owns /activate/gmail/:gmailThreadId. This export remains only
// for the frozen module surface and is intentionally not registered as a route.
export async function gmailActivation(c: AgentContext) {
	return c.json({ error: "Gmail activation is handled by the dashboard" }, 404);
}

// Automation is implemented by m02-ai-automation.
export async function threadAutomation(c: AgentContext) {
	return c.json({ error: "Automation is not configured" }, 501);
}

export async function updateThreadAutomation(c: AgentContext) {
	return c.json({ error: "Automation is not configured" }, 501);
}
