// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { SendEmailParams } from "../email-sender";
import {
	GmailApiError,
	listGmailSendAs,
	refreshGmailAccessToken,
	sendGmailMessage,
	type Fetcher,
	type GmailSendAs,
} from "./gmail-client";
import { decryptRefreshToken, hasGmailSendScope } from "./gmail-oauth";
import type { Env } from "../types";

export const GMAIL_CREDENTIAL_ID = "primary";

export class GmailSendError extends Error {
	constructor(
		message: string,
		readonly code:
			| "not-connected"
			| "missing-scope"
			| "unauthorized"
			| "invalid-request"
			| "transport-failure",
	) {
		super(message);
		this.name = "GmailSendError";
	}
}

interface GmailCredentialsRow {
	account_email?: string;
	encrypted_refresh_token?: string;
	scope?: string;
}

function credentialString(row: Record<string, unknown> | null, key: string): string | null {
	const value = row?.[key];
	return typeof value === "string" && value ? value : null;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlFromString(value: string): string {
	return base64UrlFromBytes(new TextEncoder().encode(value));
}

/** Remove line breaks from header values to prevent header injection. */
function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encode non-ASCII header values; ASCII passes through unchanged. */
function encodeHeaderValue(value: string): string {
	if (/^[\x00-\x7f]*$/.test(value)) return sanitizeHeaderValue(value);
	return "=?utf-8?B?" + base64UrlFromString(sanitizeHeaderValue(value)) + "?=";
}

/**
 * Build the base64url raw RFC 2822 message for the Gmail API. The From is the
 * resolved sender (a verified send-as alias such as the original recipient
 * address, or the authenticated account as fallback); the To is the reply
 * recipient; In-Reply-To/References preserve the conversation chain so Gmail
 * threads the reply. Deliberately dependency-free: this is the critical send
 * path, so it must not rely on transitive packages that need Node builtins.
 */
export function buildGmailRawMessage(params: SendEmailParams, fromEmail: string): string {
	const recipient = Array.isArray(params.to) ? params.to[0] : params.to;
	const lines = [
		`From: ${fromEmail}`,
		`To: ${recipient}`,
		`Subject: ${encodeHeaderValue(params.subject)}`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 7bit",
	];
	if (params.headers) {
		if (params.headers["In-Reply-To"]) lines.push(`In-Reply-To: ${sanitizeHeaderValue(params.headers["In-Reply-To"])}`);
		if (params.headers.References) lines.push(`References: ${sanitizeHeaderValue(params.headers.References)}`);
	}
	const body = (params.text ?? "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
	return base64UrlFromString(lines.join("\r\n") + "\r\n\r\n" + body);
}

function fromEmail(params: SendEmailParams): string {
	const from = params.from;
	if (typeof from === "string") return from.trim();
	if (from && typeof from === "object" && typeof from.email === "string") {
		return from.email.trim();
	}
	return "";
}

/**
 * Resolve the From address for a reply. Prefer the logical sender passed by
 * the automation (the original recipient alias, e.g. agentic-inbox-test@…)
 * when the account has it as a verified send-as alias — Gmail then sends and
 * signs as that address. Fall back to the authenticated account otherwise.
 */
export function resolveGmailFromEmail(
	params: SendEmailParams,
	accountEmail: string,
	sendAs: GmailSendAs[],
): string {
	const requested = fromEmail(params).toLowerCase();
	const account = accountEmail.toLowerCase();
	if (!requested) return accountEmail;
	if (requested === account) return accountEmail;
	const verified = sendAs.find((alias) =>
		(alias.sendAsEmail ?? "").toLowerCase() === requested &&
		alias.verificationStatus === "verified",
	);
	return verified?.sendAsEmail ?? accountEmail;
}

interface GmailReplySenderOptions {
	fetcher?: Fetcher;
}

/**
 * Create the Gmail send capability for the automation, or null when the
 * account has no stored Gmail credentials. The returned sender refreshes the
 * access token on every call (cheap, correct) and posts the raw message to
 * users.messages.send, which signs it as the resolved sender (a verified
 * send-as alias when available) and files it in Sent.
 */
export async function createGmailReplySender(
	env: Env,
	mailboxId: string,
	options: GmailReplySenderOptions = {},
): Promise<((params: SendEmailParams) => Promise<{ messageId: string }>) | null> {
	const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_TOKEN_ENCRYPTION_KEY } = env;
	if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_TOKEN_ENCRYPTION_KEY) {
		return null;
	}
	if (!env.MAILBOX) return null;

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as {
		getGmailCredentialsForUse(id?: string): Promise<Record<string, unknown> | null>;
	};
	const row = await stub.getGmailCredentialsForUse(GMAIL_CREDENTIAL_ID);
	const accountEmail = credentialString(row, "account_email");
	const encryptedRefreshToken = credentialString(row, "encrypted_refresh_token");
	const scope = credentialString(row, "scope");
	if (!accountEmail || !encryptedRefreshToken || !scope) return null;

	const fetcher = options.fetcher ?? fetch;

	return async (params: SendEmailParams): Promise<{ messageId: string }> => {
		if (!hasGmailSendScope(scope)) {
			throw new GmailSendError(
				"Gmail reauthorization is required to send replies (missing gmail.send scope).",
				"missing-scope",
			);
		}

		let refreshToken: string;
		try {
			refreshToken = await decryptRefreshToken(encryptedRefreshToken, GMAIL_TOKEN_ENCRYPTION_KEY);
		} catch {
			throw new GmailSendError("Stored Gmail credentials cannot be decrypted.", "not-connected");
		}

		let accessToken: string;
		try {
			accessToken = await refreshGmailAccessToken({
				refreshToken,
				clientId: GMAIL_CLIENT_ID,
				clientSecret: GMAIL_CLIENT_SECRET,
				storedScope: scope,
				fetcher,
			});
		} catch (error) {
			if (error instanceof GmailApiError && error.status === 401) {
				throw new GmailSendError("Gmail authorization must be reconnected.", "unauthorized");
			}
			throw new GmailSendError("Gmail token refresh failed.", "transport-failure");
		}

		let sendAs: GmailSendAs[];
		try {
			sendAs = await listGmailSendAs(accessToken, fetcher);
		} catch {
			// Listing aliases is best-effort; sending still works as the account.
			sendAs = [];
		}
		const from = resolveGmailFromEmail(params, accountEmail, sendAs);

		try {
			const sent = await sendGmailMessage(accessToken, {
				raw: buildGmailRawMessage(params, from),
				threadId: params.threadId,
			}, fetcher);
			return { messageId: sent.id };
		} catch (error) {
			if (error instanceof GmailApiError) {
				if (error.status === 401 || error.status === 403) {
					throw new GmailSendError("Gmail authorization must be reconnected.", "unauthorized");
				}
				if (error.status === 400) {
					throw new GmailSendError("Gmail rejected the reply message.", "invalid-request");
				}
			}
			throw new GmailSendError("Gmail API send failed.", "transport-failure");
		}
	};
}
