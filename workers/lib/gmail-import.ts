import type {
	GmailHeader,
	GmailMessage,
	GmailMessagePart,
	GmailThread,
} from "./gmail-client";
import { Folders } from "../../shared/folders";

export interface GmailMessageIdentity {
	source?: string;
	sourceMessageId?: string | null;
	rfcMessageId?: string | null;
	idempotencyKey?: string | null;
}

export interface GmailStoredEmail {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	date: string;
	body: string;
	read: boolean;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string;
	message_id: string | null;
	raw_headers: string;
	source: "gmail";
	source_message_id: string;
	rfc_message_id: string | null;
	idempotency_key: string;
}

export interface GmailImportStore {
	findEmailByIdentity(identity: GmailMessageIdentity): Promise<unknown | null>;
	createEmail(
		folder: string,
		email: GmailStoredEmail,
		attachments: unknown[],
	): Promise<void>;
	moveEmail?(id: string, folderId: string): Promise<boolean>;
	rethreadEmail?(id: string, threadId: string): Promise<boolean>;
	refreshGmailEmail?(id: string, email: GmailStoredEmail, folderId: string): Promise<boolean>;
}

export interface GmailThreadImportResult {
	threadId: string;
	importedMessageCount: number;
}

export class GmailImportError extends Error {
	constructor(
		message: string,
		readonly status: number = 502,
	) {
		super(message);
		this.name = "GmailImportError";
	}
}

function recordString(row: unknown, key: string): string | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) return null;
	const value = (row as Record<string, unknown>)[key];
	return typeof value === "string" && value ? value : null;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
	const header = (headers ?? []).find(
		(item) => item.name?.toLowerCase() === name.toLowerCase(),
	);
	return header?.value?.trim() ?? "";
}

export function normalizeRfcMessageId(value: string | undefined): string | null {
	if (!value) return null;
	const bracketed = value.match(/<([^<>\s]+)>/);
	const candidate = (bracketed?.[1] ?? value.trim().split(/\s+/)[0] ?? "").trim();
	return candidate || null;
}

export function parseRfcReferences(value: string | undefined): string[] {
	if (!value) return [];
	const candidates = value.split(/\s+/);
	const seen = new Set<string>();
	const references: string[] = [];
	for (const candidate of candidates) {
		const normalized = normalizeRfcMessageId(candidate);
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			references.push(normalized);
		}
	}
	return references;
}

function decodeGmailBody(value: string | undefined): string {
	if (!value) return "";
	try {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

function htmlToText(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function plainTextToHtml(value: string): string {
	const lines = value.replace(/\r\n?/g, "\n").split("\n");
	const output: string[] = [];
	let paragraph: string[] = [];
	let quote: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) {
			output.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
			paragraph = [];
		}
	};
	const flushQuote = () => {
		if (quote.length) {
			output.push(`<blockquote>${quote.map((line) => escapeHtml(line.replace(/^> ?/, ""))).join("<br>")}</blockquote>`);
			quote = [];
		}
	};
	for (const line of lines) {
		if (/^\s*>/.test(line)) {
			flushParagraph();
			quote.push(line);
		} else if (!line.trim()) {
			flushParagraph();
			flushQuote();
		} else {
			flushQuote();
			paragraph.push(line);
		}
	}
	flushParagraph();
	flushQuote();
	return output.join("");
}

function collectBodies(
	part: GmailMessagePart | undefined,
	plainText: string[],
	html: string[],
): void {
	if (!part) return;
	const body = decodeGmailBody(part.body?.data);
	if (part.mimeType?.toLowerCase() === "text/plain" && body) {
		plainText.push(body);
	}
	if (part.mimeType?.toLowerCase() === "text/html" && body) {
		html.push(body);
	}
	for (const child of part.parts ?? []) collectBodies(child, plainText, html);
}

export function gmailPlainTextBody(payload: GmailMessagePart | undefined): string {
	const plainText: string[] = [];
	const html: string[] = [];
	collectBodies(payload, plainText, html);
	if (plainText.length > 0) return plainText.join("\n\n").trim();
	return html.map(htmlToText).filter(Boolean).join("\n\n").trim();
}

function messageTimestamp(message: GmailMessage, headers: GmailHeader[] | undefined): number {
	const internalDate = Number(message.internalDate);
	if (Number.isFinite(internalDate) && internalDate > 0) return internalDate;
	const headerDate = Date.parse(headerValue(headers, "date"));
	return Number.isFinite(headerDate) ? headerDate : 0;
}

function messageDate(message: GmailMessage, headers: GmailHeader[] | undefined): string {
	return new Date(messageTimestamp(message, headers)).toISOString();
}

function toStoredEmail(message: GmailMessage, threadId: string): GmailStoredEmail {
	const sourceMessageId = message.id;
	if (!sourceMessageId) throw new GmailImportError("Gmail returned a message without an ID");
	const headers = message.payload?.headers;
	const rfcMessageId = normalizeRfcMessageId(headerValue(headers, "message-id"));
	const references = parseRfcReferences(headerValue(headers, "references"));
	const inReplyTo = normalizeRfcMessageId(headerValue(headers, "in-reply-to"));
	return {
		id: "gmail:" + sourceMessageId,
		subject: headerValue(headers, "subject"),
		sender: headerValue(headers, "from").toLowerCase(),
		recipient: headerValue(headers, "to").toLowerCase(),
		cc: headerValue(headers, "cc").toLowerCase() || null,
		bcc: headerValue(headers, "bcc").toLowerCase() || null,
		date: messageDate(message, headers),
		body: plainTextToHtml(gmailPlainTextBody(message.payload)),
		read: !(message.labelIds ?? []).includes("UNREAD"),
		in_reply_to: inReplyTo,
		email_references: references.length > 0 ? JSON.stringify(references) : null,
		thread_id: threadId,
		message_id: rfcMessageId,
		raw_headers: JSON.stringify(headers ?? []),
		source: "gmail",
		source_message_id: sourceMessageId,
		rfc_message_id: rfcMessageId,
		idempotency_key: "gmail:" + sourceMessageId,
	};
}

function messageIdentity(message: GmailMessage): GmailMessageIdentity {
	const sourceMessageId = message.id;
	if (!sourceMessageId) throw new GmailImportError("Gmail returned a message without an ID");
	return {
		source: "gmail",
		sourceMessageId,
		rfcMessageId: normalizeRfcMessageId(
			headerValue(message.payload?.headers, "message-id"),
		),
		idempotencyKey: "gmail:" + sourceMessageId,
	};
}

function isUniqueConstraint(error: unknown): boolean {
	return error instanceof Error && /unique|constraint/i.test(error.message);
}

function localThreadId(gmailThreadId: string): string {
	return "gmail:" + gmailThreadId;
}

function gmailFolder(message: GmailMessage): string {
	const labels = new Set(message.labelIds ?? []);
	if (labels.has("DRAFT")) return Folders.DRAFT;
	if (labels.has("TRASH")) return Folders.TRASH;
	if (labels.has("SPAM")) return Folders.SPAM;
	if (labels.has("SENT")) return Folders.SENT;
	if (labels.has("INBOX")) return Folders.INBOX;
	return Folders.ARCHIVE;
}

export async function importGmailThread(input: {
	gmailThreadId: string;
	thread: GmailThread;
	store: GmailImportStore;
	forceRefresh?: boolean;
}): Promise<GmailThreadImportResult> {
	if (input.thread.id && input.thread.id !== input.gmailThreadId) {
		throw new GmailImportError("Gmail returned a different thread than requested");
	}
	const messages = input.thread.messages ?? [];
	if (messages.length === 0) {
		throw new GmailImportError("Gmail returned an empty thread");
	}

	const ordered = messages
		.map((message, index) => ({ message, index }))
		.sort((left, right) => {
			const leftTimestamp = messageTimestamp(left.message, left.message.payload?.headers);
			const rightTimestamp = messageTimestamp(right.message, right.message.payload?.headers);
			return leftTimestamp - rightTimestamp || left.index - right.index;
		})
		.map(({ message }) => message);

	const threadId = localThreadId(input.gmailThreadId);
	for (const message of ordered) {
		if (message.threadId && message.threadId !== input.gmailThreadId) {
			throw new GmailImportError("Gmail returned a message from another thread");
		}
		const existing = await input.store.findEmailByIdentity(messageIdentity(message));
		const existingThreadId = recordString(existing, "thread_id");
	}

	let importedMessageCount = 0;
	for (const message of ordered) {
		const identity = messageIdentity(message);
		const existing = await input.store.findEmailByIdentity(identity);
		if (existing) {
			const existingThreadId = recordString(existing, "thread_id");
			if (existingThreadId && existingThreadId !== threadId && input.store.rethreadEmail && typeof (existing as Record<string, unknown>).id === "string") {
				await input.store.rethreadEmail(String((existing as Record<string, unknown>).id), threadId);
			}
			if (input.forceRefresh && input.store.refreshGmailEmail && typeof (existing as Record<string, unknown>).id === "string") {
				await input.store.refreshGmailEmail(String((existing as Record<string, unknown>).id), toStoredEmail(message, threadId), gmailFolder(message));
			}
			if (input.store.moveEmail && typeof (existing as Record<string, unknown>).id === "string") {
				await input.store.moveEmail(String((existing as Record<string, unknown>).id), gmailFolder(message));
			}
			continue;
		}

		const email = toStoredEmail(message, threadId);
		const folder = gmailFolder(message);
		try {
			await input.store.createEmail(folder, email, []);
			importedMessageCount++;
		} catch (error) {
			if (!isUniqueConstraint(error)) throw error;
			const raced = await input.store.findEmailByIdentity(identity);
			if (!raced) throw error;
			const racedThreadId = recordString(raced, "thread_id");
			if (racedThreadId && racedThreadId !== threadId && input.store.rethreadEmail && typeof (raced as Record<string, unknown>).id === "string") {
				await input.store.rethreadEmail(String((raced as Record<string, unknown>).id), threadId);
			}
		}
	}

	return { threadId, importedMessageCount };
}
