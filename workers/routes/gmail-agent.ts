import type { Context } from "hono";
import type { Env } from "../types";

export type AgentContext = Context<{ Bindings: Env }>;

/** Module contract frozen by the coordinator; Gmail worker replaces these stubs. */
export async function gmailStatus(c: AgentContext) { return c.json({ connected: false, accountEmail: null }); }
export async function gmailOAuthStart(c: AgentContext) { return c.json({ error: "Gmail OAuth is not configured" }, 501); }
export async function gmailOAuthCallback(c: AgentContext) { return c.json({ error: "Gmail OAuth is not configured" }, 501); }
export async function gmailImport(c: AgentContext) { return c.json({ error: "Gmail import is not configured" }, 501); }
export async function gmailActivation(c: AgentContext) { return c.json({ error: "Gmail activation is not configured" }, 501); }

export async function threadAutomation(c: AgentContext) { return c.json({ error: "Automation is not configured" }, 501); }
export async function updateThreadAutomation(c: AgentContext) { return c.json({ error: "Automation is not configured" }, 501); }
