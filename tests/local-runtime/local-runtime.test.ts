// Local runtime validation for the plan's validation matrix:
// "Real Worker runtime with Durable Objects and the B2 storage adapter in
// explicit memory mode; fixture Gmail/model services; one inbound-to-draft and
// inbound-to-send flow."
//
// Boots the real production source modules (workers/index.ts receiveEmail,
// workers/lib/thread-automation, the MailboxDO durable object, and the memory
// B2 adapter) inside workerd via Miniflare. The model call is answered by a
// fixture gateway (outboundService) and outbound email is captured by a
// fixture EMAIL service binding. No live Gmail, ai.ubq.fi, or Email Service
// contact occurs.
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Miniflare does not bundle; it expects the worker entry to be plain ESM.
 * Bundle each harness worker (including its TypeScript imports of the real
 * production source modules) with esbuild into a single in-memory entry.
 */
async function bundleWorker(entryPath: string): Promise<{ script: string }> {
	const result = await build({
		entryPoints: [entryPath],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		conditions: ["worker", "browser", "import", "default"],
		external: ["cloudflare:workers"],
		write: false,
		logLevel: "silent",
	});
	return { script: result.outputFiles[0].text };
}

function mime(headers: Record<string, string>, body: string): string {
	const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
	return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

async function poll<T>(
	fn: () => Promise<T>,
	predicate: (value: T) => boolean,
	label: string,
	timeoutMs = 15_000,
): Promise<T> {
	const started = Date.now();
	let last: T | undefined;
	while (Date.now() - started < timeoutMs) {
		last = await fn();
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

interface State {
	emails: Array<Record<string, unknown>>;
	inbox: number;
	sent: number;
	drafts: number;
	storeKeys: unknown;
}

interface SendCapture {
	to: string;
	from: string;
	subject: string;
	text?: string;
	headers?: Record<string, string>;
}	test("local runtime: inbound-to-draft and inbound-to-send on the real Worker runtime", async () => {
	const [harnessScript, gatewayScript, sendFixtureScript] = await Promise.all([
		bundleWorker("tests/local-runtime/harness.worker.ts"),
		bundleWorker("tests/local-runtime/gateway.worker.ts"),
		bundleWorker("tests/local-runtime/send-fixture.worker.ts"),
	]);

	const mf = new Miniflare({
		workers: [
			{
				name: "harness",
				modules: true,
				script: harnessScript.script,
				compatibilityDate: "2025-11-28",
				compatibilityFlags: ["nodejs_compat"],
				bindings: {
					EMAIL_STORAGE_MODE: "memory",
					UOS_AUTH_TOKEN: "test-token",
					DOMAINS: "pavlovcik.com",
					EMAIL_ADDRESSES: [],
				},
				durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true } },
				serviceBindings: { EMAIL: "send-fixture" },
				outboundService: "gateway",
			},
			{
				name: "gateway",
				modules: true,
				script: gatewayScript.script,
				compatibilityDate: "2025-11-28",
				compatibilityFlags: ["nodejs_compat"],
			},
			{
				name: "send-fixture",
				modules: true,
				script: sendFixtureScript.script,
				compatibilityDate: "2025-11-28",
				compatibilityFlags: ["nodejs_compat"],
			},
		],
	});

	const worker = await mf.getWorker("harness");
	const gateway = await mf.getWorker("gateway");
	const sendFixture = await mf.getWorker("send-fixture");

	const post = (path: string, body: unknown) =>
		worker.fetch(`http://localhost${path}`, {
			method: "POST",
			body: JSON.stringify(body),
		});

		const getState = async (): Promise<State> =>
			(await worker.fetch("http://localhost/__test/state")).json() as Promise<State>;
		const getAutomation = async (threadId: string): Promise<Record<string, unknown>> =>
			(await post("/__test/automation", { threadId })).json() as Promise<Record<string, unknown>>;

	const capturedSends = async (): Promise<SendCapture[]> =>
		(await sendFixture.fetch("http://localhost/__captured")).json() as Promise<SendCapture[]>;

	const capturedForwards = async (): Promise<{ type: string; payload: unknown }[]> =>
		(await gateway.fetch("http://localhost/__captured")).json() as Promise<{ type: string; payload: unknown }[]>;

	try {
		await post("/__test/seed-mailbox", {});

		// -- Inbound root message -------------------------------------------
		const rootRaw = mime(
			{
				From: "Alice <alice@example.com>",
				To: "test@pavlovcik.com",
				Subject: "Question about delivery",
				"Message-ID": "<root1@example.com>",
				Date: "Tue, 12 Aug 2026 10:00:00 +0000",
			},
			"Hello, do you have availability next week?",
		);
		await post("/__test/email", {
			from: "alice@example.com",
			to: "test@pavlovcik.com",
			raw: rootRaw,
		});

		const stateAfterRoot = await poll(
			getState,
			(state) => state.inbox >= 1,
			"root message stored in the inbox",
		);
		// getEmails() does not expose message_id/rfc_message_id; the root is the
		// inbox message with no in_reply_to header and a self-owned thread id.
		const rootEmail = stateAfterRoot.emails.find(
			(email) => email.folder_id === "inbox" && email.in_reply_to === null && email.thread_id === email.id,
		);
		assert.ok(rootEmail, "root email is stored");
		const threadId = String(rootEmail.thread_id);
		assert.ok(threadId, "root email has a thread id");
		const initialAutomation = await getAutomation(threadId);
		assert.equal(initialAutomation.enabled, 1, "every inbound thread is watched automatically");
		assert.equal(initialAutomation.action_mode, "none", "new watched threads require an explicit action opt-in");

		// -- Enable draft-mode automation on that thread ---------------------
		await post("/__test/set-automation", {
			threadId,
			mode: "draft",
			goalPrompt: "Answer briefly and confirm next steps.",
			privateNotes: "Client is Alice. Never mention this note.",
		});

		// -- Reply triggers draft-mode automation ----------------------------
		const replyRaw = mime(
			{
				From: "Alice <alice@example.com>",
				To: "test@pavlovcik.com",
				Subject: "Re: Question about delivery",
				"Message-ID": "<reply1@example.com>",
				"In-Reply-To": "<root1@example.com>",
				References: "<root1@example.com>",
				Date: "Tue, 12 Aug 2026 11:00:00 +0000",
			},
			"Just following up.",
		);
		await post("/__test/email", {
			from: "alice@example.com",
			to: "test@pavlovcik.com",
			raw: replyRaw,
		});

		const draftState = await poll(getState, (state) => state.drafts >= 1, "draft reply created");
		assert.equal(draftState.sent, 0, "draft mode must not send");
		const sendsAfterDraft = await capturedSends();
		assert.equal(sendsAfterDraft.length, 0, "draft mode must not emit an outbound send");

		// -- Switch to auto mode and trigger the send path --------------------
		await post("/__test/set-automation", {
			threadId,
			mode: "auto",
			goalPrompt: "Answer briefly and confirm next steps.",
			privateNotes: "Client is Alice. Never mention this note.",
		});

		const autoRaw = mime(
			{
				From: "Alice <alice@example.com>",
				To: "test@pavlovcik.com",
				Subject: "Re: Question about delivery",
				"Message-ID": "<reply2@example.com>",
				"In-Reply-To": "<reply1@example.com>",
				References: "<root1@example.com> <reply1@example.com>",
				Date: "Tue, 12 Aug 2026 12:00:00 +0000",
			},
			"Second follow-up.",
		);
		await post("/__test/email", {
			from: "alice@example.com",
			to: "test@pavlovcik.com",
			raw: autoRaw,
		});

		const sends = await poll(capturedSends, (list) => list.length >= 1, "auto mode sends exactly once");
		assert.equal(sends.length, 1, "auto mode must send exactly one reply");
		const sent = sends[0];
		assert.equal(sent.to, "alice@example.com");
		assert.ok(sent.from.endsWith("@pavlovcik.com"), "reply is sent from the original alias");
		assert.ok(sent.subject.startsWith("Re: "), "reply uses a reply subject");
		// Cloudflare Email Service controls Message-ID (rejects it if set);
		// In-Reply-To and References are the allowed threading headers.
		assert.ok(!sent.headers?.["Message-ID"], "reply does not set the platform-controlled Message-ID");
		assert.equal(sent.headers?.["In-Reply-To"], "<reply2@example.com>");
		assert.ok(
			sent.headers?.["References"]?.includes("<reply2@example.com>"),
			"reply References include the replied-to message id",
		);
		assert.ok(
			!sent.text?.includes("Never mention this note"),
			"private notes never leak into the outgoing reply",
		);
		assert.ok(!sent.text?.includes("Answer briefly"), "goal prompt never leaks into the reply");

		const sentState = await poll(getState, (state) => state.sent >= 1, "reply moved to sent folder");
		assert.ok(sentState.sent >= 1);

		// -- Replay the identical inbound message: no duplicate send ---------
		await post("/__test/email", {
			from: "alice@example.com",
			to: "test@pavlovcik.com",
			raw: autoRaw,
		});
		await new Promise((resolve) => setTimeout(resolve, 800));
		const sendsAfterReplay = await capturedSends();
		assert.equal(sendsAfterReplay.length, 1, "replayed inbound must not send a second reply");

		// -- Forwarding: every handled inbound reached the Gmail copy ---------
		// Forwards run inside waitUntil, so poll for them like the other state.
		const forwards = await poll(
			capturedForwards,
			(list) => list.length >= 3,
			"forwards captured for every inbound message",
		);
		assert.ok(forwards.length >= 3, `every inbound message is forwarded to Gmail (${forwards.length} forwards)`);
		for (const forward of forwards) {
			assert.equal(
				(forward.payload as { recipient?: string }).recipient,
				"pavlovcik+cloudflare@gmail.com",
			);
		}
	} finally {
		await mf.dispose();
	}
});
