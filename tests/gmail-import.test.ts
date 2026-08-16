import assert from "node:assert/strict";
import test from "node:test";
import {
	GMAIL_READONLY_SCOPE,
	createGmailAuthorization,
	decryptRefreshToken,
	encryptRefreshToken,
	validateGmailReturnPath,
} from "../workers/lib/gmail-oauth";
import {
	importGmailThread,
	parseRfcReferences,
	type GmailImportStore,
	type GmailStoredEmail,
} from "../workers/lib/gmail-import";
import type { GmailThread } from "../workers/lib/gmail-client";

function gmailData(value: string): string {
	return btoa(value)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function plainPayload(headers: Record<string, string>, body: string) {
	return {
		mimeType: "text/plain",
		headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
		body: { data: gmailData(body) },
	};
}

class MemoryGmailStore implements GmailImportStore {
	readonly emails: GmailStoredEmail[] = [];
	readonly folders: string[] = [];

	async findEmailByIdentity(identity: {
		source?: string;
		sourceMessageId?: string | null;
		rfcMessageId?: string | null;
		idempotencyKey?: string | null;
	}): Promise<unknown | null> {
		return this.emails.find((email) =>
			(email.source === (identity.source ?? "gmail") &&
				email.source_message_id === identity.sourceMessageId) ||
			(Boolean(identity.rfcMessageId) &&
				email.rfc_message_id === identity.rfcMessageId) ||
			(Boolean(identity.idempotencyKey) &&
				email.idempotency_key === identity.idempotencyKey)
		) ?? null;
	}

	async createEmail(
		folder: "inbox" | "sent",
		email: GmailStoredEmail,
	): Promise<void> {
		const existing = await this.findEmailByIdentity({
			source: email.source,
			sourceMessageId: email.source_message_id,
			rfcMessageId: email.rfc_message_id,
			idempotencyKey: email.idempotency_key,
		});
		if (existing) throw new Error("UNIQUE constraint failed");
		this.folders.push(folder);
		this.emails.push(email);
	}
}

test("OAuth authorization uses PKCE and the Gmail read-only scope", async () => {
	const authorization = await createGmailAuthorization({
		clientId: "client-id",
		redirectUri: "https://inbox.example/api/v1/gmail/oauth/callback",
		returnPath: "/activate/gmail/abc",
		now: new Date("2026-08-14T00:00:00.000Z"),
	});
	const url = new URL(authorization.authorizationUrl);

	assert.equal(url.origin, "https://accounts.google.com");
	assert.equal(url.searchParams.get("scope"), GMAIL_READONLY_SCOPE);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(
		url.searchParams.get("state"),
		authorization.oauthState.state,
	);
	assert.match(authorization.oauthState.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
	assert.notEqual(
		url.searchParams.get("code_challenge"),
		authorization.oauthState.codeVerifier,
	);
	assert.equal(
		authorization.oauthState.expiresAt,
		"2026-08-14T00:10:00.000Z",
	);
});

test("OAuth return paths stay on the current activation route", () => {
	assert.equal(
		validateGmailReturnPath(
			"/activate/gmail/abc?from=extension",
			"https://inbox.example/api/v1/gmail/oauth/start",
		),
		"/activate/gmail/abc?from=extension",
	);
	assert.throws(
		() =>
			validateGmailReturnPath(
				"https://attacker.example/activate/gmail/abc",
				"https://inbox.example/api/v1/gmail/oauth/start",
			),
		/Invalid Gmail activation return path/,
	);
});

test("refresh credentials are randomized encrypted ciphertext", async () => {
	const refreshToken = "refresh-token-that-must-not-be-stored-as-plaintext";
	const secret = "test encryption secret";
	const first = await encryptRefreshToken(refreshToken, secret);
	const second = await encryptRefreshToken(refreshToken, secret);

	assert.match(first, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	assert.notEqual(first, second);
	assert.equal(first.includes(refreshToken), false);
	assert.equal(await decryptRefreshToken(first, secret), refreshToken);
	await assert.rejects(
		() => decryptRefreshToken(first, "different secret"),
		/Stored Gmail credentials cannot be decrypted/,
	);
});

test("imports every threads.get message chronologically and remains idempotent", async () => {
	const store = new MemoryGmailStore();
	const thread: GmailThread = {
		id: "thread-1",
		messages: [
			{
				id: "message-2",
				threadId: "thread-1",
				internalDate: "200",
				labelIds: ["SENT"],
				payload: plainPayload(
					{
						From: "Owner <owner@example.com>",
						To: "Sender <sender@example.com>",
						Subject: "Re: Hello",
						"Message-ID": "<two@example.com>",
						"In-Reply-To": "<one@example.com>",
						References: "<root@example.com> <one@example.com>",
					},
					"second body",
				),
			},
			{
				id: "message-1",
				threadId: "thread-1",
				internalDate: "100",
				labelIds: ["INBOX", "UNREAD"],
				payload: plainPayload(
					{
						From: "Sender <sender@example.com>",
						To: "Owner <owner@example.com>",
						Subject: "Hello",
						"Message-ID": "<one@example.com>",
					},
					"first body",
				),
			},
		],
	};

	const first = await importGmailThread({
		gmailThreadId: "thread-1",
		thread,
		store,
	});
	const second = await importGmailThread({
		gmailThreadId: "thread-1",
		thread,
		store,
	});

	assert.deepEqual(first, {
		threadId: "gmail:thread-1",
		importedMessageCount: 2,
	});
	assert.deepEqual(second, {
		threadId: "gmail:thread-1",
		importedMessageCount: 0,
	});
	assert.deepEqual(
		store.emails.map((email) => email.source_message_id),
		["message-1", "message-2"],
	);
	assert.deepEqual(store.folders, ["inbox", "sent"]);
	assert.equal(store.emails[0].read, false);
	assert.equal(store.emails[1].read, true);
	assert.equal(store.emails[1].in_reply_to, "one@example.com");
	assert.deepEqual(
		JSON.parse(store.emails[1].email_references ?? "[]"),
		["root@example.com", "one@example.com"],
	);
	assert.equal(store.emails[0].body, "first body");
	assert.equal(store.emails[1].body, "second body");
});

test("RFC identities join imported Gmail history to an existing local thread", async () => {
	const store = new MemoryGmailStore();
	store.emails.push({
		id: "cloudflare-original",
		subject: "Hello",
		sender: "sender@example.com",
		recipient: "owner@example.com",
		cc: null,
		bcc: null,
		date: "2026-08-14T00:00:00.000Z",
		body: "already stored",
		read: true,
		in_reply_to: null,
		email_references: null,
		thread_id: "local-cloudflare-thread",
		message_id: "one@example.com",
		raw_headers: "[]",
		source: "gmail",
		source_message_id: "existing-source",
		rfc_message_id: "one@example.com",
		idempotency_key: "existing-source",
	});

	const result = await importGmailThread({
		gmailThreadId: "thread-2",
		thread: {
			id: "thread-2",
			messages: [
				{
					id: "message-1",
					threadId: "thread-2",
					internalDate: "100",
					payload: plainPayload(
						{ "Message-ID": "<one@example.com>" },
						"already stored",
					),
				},
				{
					id: "message-2",
					threadId: "thread-2",
					internalDate: "200",
					payload: plainPayload(
						{
							"Message-ID": "<two@example.com>",
							"In-Reply-To": "<one@example.com>",
						},
						"new reply",
					),
				},
			],
		},
		store,
	});

	assert.equal(result.threadId, "local-cloudflare-thread");
	assert.equal(result.importedMessageCount, 1);
	assert.equal(store.emails.length, 2);
	assert.equal(store.emails[1].thread_id, "local-cloudflare-thread");
	assert.deepEqual(
		parseRfcReferences("<one@example.com> <one@example.com> bare@example.com"),
		["one@example.com", "bare@example.com"],
	);
});
