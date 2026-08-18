// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache-2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Folders } from "../../shared/folders";
import { sendEmail, type SendEmailParams } from "../email-sender";
import { generateMessageId, stripHtmlToText } from "./email-helpers";
import { AiUosChatClient, AiUosError, type AiUosMessage, validateAiUosReplyBody } from "./ai-uos";
import type { AgentAction, AutomationMode, ProcessingStatus, ThreadAutomation } from "./agent-contract";
import { buildThreadReplyPrompt, replyLeaksTrustedText, type ThreadPromptMessage } from "./thread-prompt";
import type { Env } from "../types";

/** The one logical inbox used for every @pavlovcik.com alias. */
export const PAVLOVCIK_LOGICAL_INBOX_ID = "pavlovcik.com";

type UnknownRecord = Record<string, unknown>;

export interface AutomationStoredMessage {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	date: string;
	body: string;
	inReplyTo: string | null;
	emailReferences: string | null;
	messageId: string | null;
	rfcMessageId: string | null;
	source: string | null;
}

export interface AutomationOutgoingEmail {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	date: string;
	body: string;
	in_reply_to: string;
	email_references: string;
	thread_id: string;
	message_id: string;
	raw_headers: string;
	source: "agent";
	source_message_id: string;
	rfc_message_id: string;
	idempotency_key: string;
}

/**
 * This interface is the automation-side view of the coordinator-owned DO.
 * `claimProcessingReceipt` is one DO RPC and therefore the atomic duplicate
 * gate. `finalizeProcessing` atomically updates both the receipt and visible
 * per-thread action state.
 */
export interface AutomationStore {
	getEmail(messageId: string): Promise<UnknownRecord | null>;
	getThreadEmails(threadId: string): Promise<UnknownRecord[]>;
	resolveThreadForMessage(messageId: string): Promise<string | null>;
	getThreadAutomation(threadId: string): Promise<UnknownRecord | null>;
	upsertThreadAutomation(input: {
		threadId: string;
		gmailThreadId?: string | null;
		mode: AutomationMode;
		goalPrompt: string;
		privateNotes: string;
	}): Promise<UnknownRecord | null>;
	claimProcessingReceipt(messageId: string, threadId: string): Promise<boolean>;
	updateProcessingReceipt(messageId: string, status: ProcessingStatus, error?: string | null): Promise<void>;
	finalizeProcessing(
		messageId: string,
		threadId: string,
		status: Extract<ProcessingStatus, "drafted" | "sent" | "failed">,
		action: Extract<AgentAction, "drafted" | "sent" | "failed">,
		error?: string | null,
	): Promise<void>;
	createEmail(folder: string, email: AutomationOutgoingEmail, attachments: []): Promise<void>;
	moveEmail(emailId: string, folderId: string): Promise<boolean>;
}

/** A shallow RPC view avoids expanding the recursive generated DO type. */
interface MailboxAutomationRpc {
	getEmail(messageId: string): Promise<unknown>;
	getThreadEmails(threadId: string): Promise<unknown>;
	resolveThreadForMessage(messageId: string): Promise<string | null>;
	getThreadAutomation(threadId: string): Promise<unknown>;
	upsertThreadAutomation(input: {
		threadId: string;
		gmailThreadId?: string | null;
		mode: AutomationMode;
		goalPrompt: string;
		privateNotes: string;
	}): Promise<unknown>;
	claimProcessingReceipt(messageId: string, threadId: string): Promise<boolean>;
	updateProcessingReceipt(messageId: string, status: ProcessingStatus, error?: string | null): Promise<void>;
	finalizeProcessing(
		messageId: string,
		threadId: string,
		status: Extract<ProcessingStatus, "drafted" | "sent" | "failed">,
		action: Extract<AgentAction, "drafted" | "sent" | "failed">,
		error?: string | null,
	): Promise<void>;
	createEmail(folder: string, email: AutomationOutgoingEmail, attachments: []): Promise<void>;
	moveEmail(emailId: string, folderId: string): Promise<boolean>;
}

export interface ReplyGenerator {
	complete(messages: readonly AiUosMessage[]): Promise<string>;
}

export interface InboundAutomationDependencies {
	store: AutomationStore;
	model: ReplyGenerator;
	send: (params: SendEmailParams) => Promise<{ messageId: string }>;
	now?: () => Date;
}

export interface InboundAutomationInput {
	messageId: string;
	allowGmail?: boolean;
	forceDraft?: boolean;
}

export type InboundAutomationResult =
	| { status: "ignored"; reason: "missing" | "non-cloudflare" | "unmatched" | "disabled" }
	| { status: "duplicate"; threadId: string }
	| { status: "drafted"; threadId: string; replyId: string }
	| { status: "sent"; threadId: string; replyId: string }
	| { status: "failed"; threadId: string; error: string };

class AutomationInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationInputError";
	}
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function nullableStringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function toStoredMessage(value: UnknownRecord): AutomationStoredMessage | null {
	const id = stringValue(value.id);
	if (!id) return null;
	return {
		id,
		subject: stringValue(value.subject) ?? "",
		sender: stringValue(value.sender) ?? "",
		recipient: stringValue(value.recipient) ?? "",
		date: stringValue(value.date) ?? "",
		body: stringValue(value.body) ?? "",
		inReplyTo: nullableStringValue(value.in_reply_to),
		emailReferences: nullableStringValue(value.email_references),
		messageId: nullableStringValue(value.message_id),
		rfcMessageId: nullableStringValue(value.rfc_message_id),
		source: nullableStringValue(value.source),
	};
}

function toThreadAutomation(value: UnknownRecord | null): ThreadAutomation | null {
	if (!value) return null;
	const threadId = stringValue(value.thread_id) ?? stringValue(value.threadId);
	const storedMode = stringValue(value.mode);
	if (!threadId || (storedMode !== "draft" && storedMode !== "auto")) return null;
	// Rows from before automatic watching used enabled as the action toggle.
	// Read them as no-action until a person explicitly selects Draft or Auto-send.
	const actionMode = stringValue(value.action_mode);
	const wasActionEnabled = value.enabled === true || value.enabled === 1;
	const mode: AutomationMode = actionMode === "none" || actionMode === "draft" || actionMode === "auto"
		? actionMode
		: wasActionEnabled ? storedMode : "none";
	const lastAction = stringValue(value.last_action) ?? stringValue(value.lastAction) ?? "none";
	if (lastAction !== "none" && lastAction !== "drafted" && lastAction !== "sent" && lastAction !== "failed") {
		return null;
	}
	return {
		threadId,
		gmailThreadId: nullableStringValue(value.gmail_thread_id) ?? nullableStringValue(value.gmailThreadId),
		mode,
		goalPrompt: stringValue(value.goal_prompt) ?? stringValue(value.goalPrompt) ?? "",
		privateNotes: stringValue(value.private_notes) ?? stringValue(value.privateNotes) ?? "",
		lastProcessedMessageId: nullableStringValue(value.last_processed_message_id)
			?? nullableStringValue(value.lastProcessedMessageId),
		lastAction,
		lastError: nullableStringValue(value.last_error) ?? nullableStringValue(value.lastError),
		createdAt: stringValue(value.created_at) ?? stringValue(value.createdAt) ?? "",
		updatedAt: stringValue(value.updated_at) ?? stringValue(value.updatedAt) ?? "",
	};
}

function toPromptMessage(message: AutomationStoredMessage): ThreadPromptMessage {
	return {
		id: message.id,
		sender: message.sender,
		recipient: message.recipient,
		date: message.date,
		subject: message.subject,
		body: stripHtmlToText(message.body),
	};
}

function normalizeMessageId(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const bracketed = trimmed.match(/^<([^>]+)>$/);
	return (bracketed?.[1] ?? trimmed).trim() || null;
}

function parseReferences(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => typeof item === "string" ? normalizeMessageId(item) : null)
			.filter((item): item is string => item !== null);
	} catch {
		return [];
	}
}

function replyAddress(value: string): string | null {
	const address = value.split(",").map((entry) => entry.trim().toLowerCase()).find(Boolean) ?? "";
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

function originalAlias(value: string): string | null {
	const candidates = value.split(",").map((entry) => entry.trim().toLowerCase());
	return candidates.find((candidate) => /^[^\s@]+@pavlovcik\.com$/.test(candidate)) ?? null;
}

function replySubject(subject: string): string {
	return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function safelyReportedError(error: unknown): string {
	if (error instanceof AiUosError) {
		switch (error.kind) {
			case "configuration": return "AI generation is not configured.";
			case "timeout": return "AI generation timed out.";
			case "http": return error.message;
			case "malformed": return "AI generation returned an invalid reply.";
			default: return "AI generation failed before a reply was created.";
		}
	}
	if (error instanceof AutomationInputError) return error.message;
	return "Automation failed before a reply was sent.";
}

function buildOutgoingReply(
	inbound: AutomationStoredMessage,
	threadId: string,
	replyBody: string,
	now: Date,
): { email: AutomationOutgoingEmail; headers: Record<string, string> } {
	const recipient = replyAddress(inbound.sender);
	const sender = originalAlias(inbound.recipient);
	const originalMessageId = normalizeMessageId(inbound.rfcMessageId ?? inbound.messageId);
	if (!recipient || !sender || !originalMessageId) {
		throw new AutomationInputError("Incoming message lacks safe reply routing data.");
	}

	const fromDomain = sender.split("@")[1];
	if (!fromDomain) throw new AutomationInputError("Incoming message lacks a reply sender domain.");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const references = unique([...parseReferences(inbound.emailReferences), originalMessageId]);
	// Cloudflare Email Service controls Message-ID itself (E_HEADER_NOT_ALLOWED
	// if set); In-Reply-To and References are allowlisted threading headers.
	// The outgoing message's own message_id/rfc_message_id still persist the
	// generated Message-ID for dashboard identity and RFC resolution.
	const headers = {
		"In-Reply-To": `<${originalMessageId}>`,
		References: references.map((reference) => `<${reference}>`).join(" "),
	};

	return {
		email: {
			id: messageId,
			subject: replySubject(inbound.subject),
			sender,
			recipient,
			date: now.toISOString(),
			body: replyBody,
			in_reply_to: originalMessageId,
			email_references: JSON.stringify(references),
			thread_id: threadId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: sender },
				{ key: "to", value: recipient },
				{ key: "subject", value: replySubject(inbound.subject) },
				{ key: "date", value: now.toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
				{ key: "in-reply-to", value: `<${originalMessageId}>` },
				{ key: "references", value: headers.References },
			]),
			source: "agent",
			source_message_id: messageId,
			rfc_message_id: outgoingMessageId,
			idempotency_key: `agent:${inbound.id}`,
		},
		headers,
	};
}

export class InboundAutomationService {
	readonly #store: AutomationStore;
	readonly #model: ReplyGenerator;
	readonly #send: InboundAutomationDependencies["send"];
	readonly #now: () => Date;

	constructor(dependencies: InboundAutomationDependencies) {
		this.#store = dependencies.store;
		this.#model = dependencies.model;
		this.#send = dependencies.send;
		this.#now = dependencies.now ?? (() => new Date());
	}

	async process(input: InboundAutomationInput): Promise<InboundAutomationResult> {
		const rawInbound = await this.#store.getEmail(input.messageId);
		if (!rawInbound || !isRecord(rawInbound)) return { status: "ignored", reason: "missing" };
		const inbound = toStoredMessage(rawInbound);
		if (!inbound) return { status: "ignored", reason: "missing" };
		if (inbound.source !== null && inbound.source !== "cloudflare" && !(input.allowGmail && inbound.source === "gmail")) {
			return { status: "ignored", reason: "non-cloudflare" };
		}

		const threadId = await this.#store.resolveThreadForMessage(inbound.id);
		if (!threadId) return { status: "ignored", reason: "unmatched" };

		const automation = toThreadAutomation(await this.#store.getThreadAutomation(threadId));
		if (!automation || (automation.mode === "none" && !input.forceDraft)) return { status: "ignored", reason: "disabled" };

		const claimed = await this.#store.claimProcessingReceipt(inbound.id, threadId);
		if (!claimed) return { status: "duplicate", threadId };

		try {
			const rawThread = await this.#store.getThreadEmails(threadId);
			const messages = rawThread
				.filter(isRecord)
				.map(toStoredMessage)
				.filter((message): message is AutomationStoredMessage => message !== null);
			if (messages.length === 0) {
				throw new AutomationInputError("The resolved thread has no stored messages.");
			}

			const prompt = buildThreadReplyPrompt({
				messages: messages.map(toPromptMessage),
				goalPrompt: automation.goalPrompt,
				privateNotes: automation.privateNotes,
			});
			const generated = await this.#model.complete([
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			]);
			const replyBody = validateAiUosReplyBody(generated);
			if (replyLeaksTrustedText(replyBody, automation.goalPrompt, automation.privateNotes)) {
				throw new AutomationInputError("AI generation copied trusted operator text into the reply.");
			}

			const outgoing = buildOutgoingReply(inbound, threadId, replyBody, this.#now());
			if (input.forceDraft || automation.mode === "draft") {
				await this.#store.createEmail(Folders.DRAFT, outgoing.email, []);
				await this.#store.finalizeProcessing(inbound.id, threadId, "drafted", "drafted");
				return { status: "drafted", threadId, replyId: outgoing.email.id };
			}

			// Persist a provisional agent draft before sending. If delivery becomes
			// uncertain, this record remains inspectable and the receipt prevents
			// an automatic retry that could produce a duplicate external message.
			await this.#store.createEmail(Folders.DRAFT, outgoing.email, []);
			await this.#store.updateProcessingReceipt(inbound.id, "sending");
			try {
				await this.#send({
					to: outgoing.email.recipient,
					from: outgoing.email.sender,
					subject: outgoing.email.subject,
					text: outgoing.email.body,
					headers: outgoing.headers,
					// Gmail-send transports thread explicitly when the local thread is
					// linked to a Gmail thread; otherwise Gmail threads via References.
					threadId: automation.gmailThreadId ?? undefined,
				});
			} catch (error) {
				console.error("Auto-send failed:", error instanceof Error ? {
					code: (error as { code?: string }).code,
					message: error.message,
				} : String(error));
				return this.#fail(inbound.id, threadId, "Outbound delivery is uncertain and will not be retried automatically.");
			}

			const moved = await this.#store.moveEmail(outgoing.email.id, Folders.SENT);
			if (!moved) {
				return this.#fail(inbound.id, threadId, "Outbound delivery record could not be finalized; do not resend automatically.");
			}
			await this.#store.finalizeProcessing(inbound.id, threadId, "sent", "sent");
			return { status: "sent", threadId, replyId: outgoing.email.id };
		} catch (error) {
			console.error("Thread automation failed", error instanceof Error ? {
				name: error.name,
				message: error.message,
			} : { error: String(error) });
			return this.#fail(inbound.id, threadId, safelyReportedError(error));
		}
	}

	async #fail(messageId: string, threadId: string, error: string): Promise<InboundAutomationResult> {
		try {
			await this.#store.finalizeProcessing(messageId, threadId, "failed", "failed", error);
		} catch {
			// The claim already prevents automatic duplicate work. Do not throw a
			// secondary persistence error and accidentally invite delivery retry.
		}
		return { status: "failed", threadId, error };
	}
}

/** Create the concrete DO adapter without exposing raw storage to callers. */
export function createAutomationStore(env: Env, mailboxId = PAVLOVCIK_LOGICAL_INBOX_ID): AutomationStore {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as MailboxAutomationRpc;
	return {
		getEmail: async (messageId) => (await stub.getEmail(messageId)) as UnknownRecord | null,
		getThreadEmails: async (threadId) => (await stub.getThreadEmails(threadId)) as UnknownRecord[],
		resolveThreadForMessage: (messageId) => stub.resolveThreadForMessage(messageId),
		getThreadAutomation: async (threadId) => (await stub.getThreadAutomation(threadId)) as UnknownRecord | null,
		upsertThreadAutomation: async (input) => (await stub.upsertThreadAutomation(input)) as UnknownRecord | null,
		claimProcessingReceipt: (messageId, threadId) => stub.claimProcessingReceipt(messageId, threadId),
		updateProcessingReceipt: (messageId, status, error) => stub.updateProcessingReceipt(messageId, status, error),
		finalizeProcessing: (messageId, threadId, status, action, error) => stub.finalizeProcessing(messageId, threadId, status, action, error),
		createEmail: async (folder, email, attachments) => {
			await stub.createEmail(folder, email, attachments);
		},
		moveEmail: (emailId, folderId) => stub.moveEmail(emailId, folderId),
	};
}

export interface TriggerInboundAutomationOptions {
	/**
	 * Explicit send transport override (used by tests and local fixtures).
	 */
	send?: InboundAutomationDependencies["send"];
}

/**
 * Coordinator wiring point for the Worker email handler. Calling this starts
 * no background process and has no fallback path; it is safe to use in
 * `waitUntil` after the original inbound message and forwarding have completed.
 *
 * Send transport priority: explicit override > EMAIL binding (domain-native,
 * From = the addressed alias). The EMAIL binding sends From any address on the
 * sender's verified domain — no per-address verification, no Gmail account,
 * and no same-session or inbound-DMARC gate.
 */
export async function triggerInboundAutomation(
	env: Env,
	input: InboundAutomationInput,
	mailboxId = PAVLOVCIK_LOGICAL_INBOX_ID,
	options: TriggerInboundAutomationOptions = {},
): Promise<InboundAutomationResult> {
	const service = new InboundAutomationService({
		store: createAutomationStore(env, mailboxId),
		model: new AiUosChatClient({ authToken: env.UOS_AUTH_TOKEN }),
		send: options.send
			?? ((params) => sendEmail(env.EMAIL, params)),
	});
	return service.process(input);
}

/** Public normalizer for route handlers and focused tests. */
export function normalizeThreadAutomation(value: UnknownRecord | null): ThreadAutomation | null {
	return toThreadAutomation(value);
}
