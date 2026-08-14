// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	source: text("source").notNull().default("cloudflare"),
	source_message_id: text("source_message_id"),
	rfc_message_id: text("rfc_message_id"),
	idempotency_key: text("idempotency_key"),
}, (table) => ({
	idxSourceMessage: uniqueIndex("idx_emails_source_message").on(table.source, table.source_message_id),
	idxRfcMessage: uniqueIndex("idx_emails_rfc_message").on(table.rfc_message_id),
	idxIdempotency: uniqueIndex("idx_emails_idempotency").on(table.idempotency_key),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
});

export const threadAutomation = sqliteTable("thread_automation", {
	thread_id: text("thread_id").primaryKey(), gmail_thread_id: text("gmail_thread_id"),
	enabled: integer("enabled").notNull().default(0), mode: text("mode").notNull().default("draft"),
	goal_prompt: text("goal_prompt").notNull().default(""), private_notes: text("private_notes").notNull().default(""),
	last_processed_message_id: text("last_processed_message_id"), last_action: text("last_action").notNull().default("none"),
	last_error: text("last_error"), created_at: text("created_at").notNull(), updated_at: text("updated_at").notNull(),
});

export const gmailOAuthState = sqliteTable("gmail_oauth_state", {
	state: text("state").primaryKey(), code_verifier: text("code_verifier").notNull(), redirect_uri: text("redirect_uri").notNull(),
	return_path: text("return_path").notNull(), expires_at: text("expires_at").notNull(),
});

export const gmailCredentials = sqliteTable("gmail_credentials", {
	id: text("id").primaryKey(), account_email: text("account_email").notNull(), encrypted_refresh_token: text("encrypted_refresh_token").notNull(),
	scope: text("scope").notNull(), created_at: text("created_at").notNull(), updated_at: text("updated_at").notNull(),
});

export const processingReceipts = sqliteTable("processing_receipts", {
	message_id: text("message_id").primaryKey(), thread_id: text("thread_id").notNull(), status: text("status").notNull(),
	claimed_at: text("claimed_at").notNull(), updated_at: text("updated_at").notNull(), error: text("error"),
});
