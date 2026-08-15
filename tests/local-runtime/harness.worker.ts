// Test-only harness for the plan's Local runtime validation row. It is built
// from the production source modules (not the React Router bundle) so the
// memory object-store singleton, the real Durable Object, the real inbound
// receiver, and the real automation service all run in one workerd process
// with the exact same code paths as the deployed Worker.
import { MailboxDO } from "../../workers/durableObject/index";
import { receiveEmail } from "../../workers/index";
import { getObjectStore } from "../../workers/lib/b2-storage";

export { MailboxDO };

const LOGICAL_MAILBOX_ID = "pavlovcik.com";

interface AutomationRow {
	thread_id?: string | null;
	gmail_thread_id?: string | null;
	enabled?: number | boolean;
	mode?: string | null;
	goal_prompt?: string | null;
	private_notes?: string | null;
	last_processed_message_id?: string | null;
	last_action?: string | null;
	last_error?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
}

function plain(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stub(env: Record<string, unknown>): MailboxDO {
	const namespace = env.MAILBOX as unknown as {
		idFromName(name: string): unknown;
		get(id: unknown): MailboxDO;
	};
	return namespace.get(namespace.idFromName(LOGICAL_MAILBOX_ID));
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

export default {
	async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const body = await jsonBody(request);

		if (url.pathname === "/__test/seed-mailbox") {
			const store = getObjectStore(env as never);
			await store.put(`mailboxes/${LOGICAL_MAILBOX_ID}.json`, JSON.stringify({
				fromName: "Pavlovcik Inbox",
				forwarding: { enabled: false, email: "" },
				signature: { enabled: false, text: "" },
				autoReply: { enabled: false, subject: "", message: "" },
			}));
			return new Response("mailbox seeded");
		}

		if (url.pathname === "/__test/email") {
			const raw = typeof body.raw === "string" ? body.raw : "";
			const from = typeof body.from === "string" ? body.from : "sender@example.com";
			const to = typeof body.to === "string" ? body.to : "test@pavlovcik.com";
			if (!raw) return new Response("missing raw", { status: 400 });
			const encoder = new TextEncoder();
			const bytes = encoder.encode(raw);
			const event = {
				raw: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				rawSize: bytes.byteLength,
				from,
				to,
				forward: async (recipient: string) => {
					await fetch("http://fixture/__captured-forward", {
						method: "POST",
						body: JSON.stringify({ recipient }),
					});
					return { messageId: `fwd-${recipient}` };
				},
			};
			await receiveEmail(event as never, env as never, ctx);
			return new Response("email received");
		}

		if (url.pathname === "/__test/set-automation") {
			const threadId = typeof body.threadId === "string" ? body.threadId : "";
			if (!threadId) return new Response("missing threadId", { status: 400 });
			const enabled = body.enabled === true || body.enabled === 1;
			const mode = body.mode === "auto" ? "auto" : "draft";
			const goalPrompt = typeof body.goalPrompt === "string" ? body.goalPrompt : "";
			const privateNotes = typeof body.privateNotes === "string" ? body.privateNotes : "";
			const row = (await (stub(env as Record<string, unknown>) as unknown as {
				upsertThreadAutomation(input: {
					threadId: string;
					gmailThreadId?: string | null;
					enabled: boolean;
					mode: "draft" | "auto";
					goalPrompt: string;
					privateNotes: string;
				}): Promise<unknown>;
			}).upsertThreadAutomation({
				threadId,
				enabled,
				mode,
				goalPrompt,
				privateNotes,
			})) as AutomationRow | null;
			return Response.json(row ?? {});
		}

		if (url.pathname === "/__test/state") {
			const mailbox = stub(env as Record<string, unknown>) as unknown as {
				getEmails(options?: { folder?: string }): Promise<unknown>;
				getThreadAutomation(threadId: string): Promise<unknown>;
			};
			const [inbox, sent, drafts, threadAutomations] = await Promise.all([
				mailbox.getEmails({ folder: "inbox" }),
				mailbox.getEmails({ folder: "sent" }),
				mailbox.getEmails({ folder: "draft" }),
				(await getObjectStore(env as never).list({ prefix: "" })) as unknown,
			]);
			const all = await Promise.all(
				[...(Array.isArray(inbox) ? inbox : []), ...(Array.isArray(sent) ? sent : []), ...(Array.isArray(drafts) ? drafts : [])]
					.map((row) => plain(row))
					.filter((row): row is Record<string, unknown> => row !== null),
			);
			return Response.json({
				emails: all,
				inbox: Array.isArray(inbox) ? inbox.length : 0,
				sent: Array.isArray(sent) ? sent.length : 0,
				drafts: Array.isArray(drafts) ? drafts.length : 0,
				storeKeys: Array.isArray(threadAutomations) ? threadAutomations : [],
			});
		}

		return new Response("harness 404", { status: 404 });
	},
};
