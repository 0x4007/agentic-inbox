// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache-2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { z } from "zod";
import {
	createAutomationStore,
	normalizeThreadAutomation,
} from "../lib/thread-automation";
import type { Env } from "../types";

export type ThreadAutomationContext = Context<{ Bindings: Env }>;

const ThreadAutomationUpdateSchema = z.object({
	enabled: z.boolean(),
	mode: z.enum(["draft", "auto"]),
	goalPrompt: z.string().max(12_000),
	privateNotes: z.string().max(12_000),
}).strict();

function threadIdFromContext(c: ThreadAutomationContext): string | null {
	const threadId = c.req.param("threadId")?.trim();
	return threadId || null;
}

/** GET /api/v1/threads/:threadId/automation */
export async function getThreadAutomation(c: ThreadAutomationContext) {
	const threadId = threadIdFromContext(c);
	if (!threadId) return c.json({ error: "Thread ID required" }, 400);
	const store = createAutomationStore(c.env);
	const automation = normalizeThreadAutomation(await store.getThreadAutomation(threadId));
	if (!automation) return c.json({ error: "Thread automation not found" }, 404);
	return c.json(automation);
}

/** PUT /api/v1/threads/:threadId/automation */
export async function putThreadAutomation(c: ThreadAutomationContext) {
	const threadId = threadIdFromContext(c);
	if (!threadId) return c.json({ error: "Thread ID required" }, 400);

	let update: z.infer<typeof ThreadAutomationUpdateSchema>;
	try {
		update = ThreadAutomationUpdateSchema.parse(await c.req.json());
	} catch {
		return c.json({ error: "Invalid thread automation update" }, 400);
	}

	const store = createAutomationStore(c.env);
	// The public PUT contract intentionally does not expose Gmail identity.
	// Preserve it on every update so a dashboard autosave cannot disconnect a
	// previously imported Gmail thread.
	const existing = normalizeThreadAutomation(await store.getThreadAutomation(threadId));
	const saved = normalizeThreadAutomation(await store.upsertThreadAutomation({
		threadId,
		gmailThreadId: existing?.gmailThreadId,
		...update,
	}));
	if (!saved) return c.json({ error: "Could not persist thread automation" }, 500);
	return c.json(saved);
}
