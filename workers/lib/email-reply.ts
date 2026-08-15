// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createMimeMessage } from "mimetext";
import type { SendEmailParams } from "../email-sender";

/**
 * Build a raw RFC 5322 MIME reply for Cloudflare's native `message.reply()`.
 *
 * `message.reply()` delivers within the same SMTP session as the inbound email,
 * so it does not require a verified destination address (unlike the EMAIL
 * binding's `send()`, which on accounts with only Email Routing is restricted
 * to verified destinations). It also threads the reply with the original
 * message via In-Reply-To / References, which is exactly the threading
 * contract the automation already computes. Cloudflare controls Message-ID
 * itself on this path, so it is intentionally not set here.
 */
export function buildReplyMime(params: SendEmailParams): string {
	const mime = createMimeMessage();
	const from = typeof params.from === "string" ? params.from : params.from.email;
	const to = Array.isArray(params.to) ? params.to[0] : params.to;
	mime.setSender(from);
	mime.setRecipient(to);
	mime.setSubject(params.subject);
	if (params.text) mime.addMessage({ contentType: "text/plain", data: params.text });
	if (params.html) mime.addMessage({ contentType: "text/html", data: params.html });
	if (params.headers) {
		if (params.headers["In-Reply-To"]) mime.setHeader("in-reply-to", params.headers["In-Reply-To"]);
		if (params.headers.References) mime.setHeader("references", params.headers.References);
	}
	return mime.asRaw();
}
