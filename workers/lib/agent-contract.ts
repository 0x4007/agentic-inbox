/** Every inbound thread is watched. A reply action must be opted into explicitly. */
export type AutomationMode = "none" | "draft" | "auto";
export type AgentAction = "none" | "drafted" | "sent" | "failed";
export type ProcessingStatus = "pending" | "drafted" | "sending" | "sent" | "failed";

export interface ThreadAutomation {
	threadId: string;
	gmailThreadId: string | null;
	mode: AutomationMode;
	goalPrompt: string;
	privateNotes: string;
	lastProcessedMessageId: string | null;
	lastAction: AgentAction;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface GmailImportRequest { gmailThreadId: string; }
export interface ThreadAutomationUpdate {
	mode: AutomationMode;
	goalPrompt: string;
	privateNotes: string;
}
