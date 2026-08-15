// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { SendEmailParams } from "../email-sender";

/** The runtime email-message fields receiveEmail needs (raw/rawSize/from/to/forward). */
export interface RuntimeEmailEventLike {
	raw: ReadableStream;
	rawSize: number;
	from?: string;
	to?: string;
	forward?: (recipient: string, headers?: Headers) => Promise<{ messageId: string }>;
}

/** The full plain-object shape receiveEmail accepts, with the native reply capability. */
export interface IncomingEmailEventShape extends RuntimeEmailEventLike {
	sendReply?: (params: SendEmailParams) => Promise<{ messageId: string }>;
}

/**
 * Copy the inbound event fields explicitly into a plain object.
 *
 * Spreading the runtime email message (`{ ...event }`) silently drops its
 * host-object getters: WebIDL attributes such as `raw` and `rawSize` live on
 * the prototype and are not own enumerable properties, leaving receiveEmail
 * with an undefined stream. Reading each field by name invokes the getter and
 * copies the value onto a plain object.
 *
 * WebIDL methods such as `forward` also require the host object as `this`,
 * so it is bound before copying; otherwise calling it on the plain object
 * throws "Illegal invocation".
 */
export function toIncomingEmailEvent(
	event: RuntimeEmailEventLike,
	sendReply?: IncomingEmailEventShape["sendReply"],
): IncomingEmailEventShape {
	return {
		raw: event.raw,
		rawSize: event.rawSize,
		from: event.from,
		to: event.to,
		forward: typeof event.forward === "function" ? event.forward.bind(event) : undefined,
		sendReply,
	};
}
