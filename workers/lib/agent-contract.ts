export type AutomationMode = "draft" | "auto";
export type AgentAction = "none" | "drafted" | "sent" | "failed";
export type ProcessingStatus = "pending" | "drafted" | "sending" | "sent" | "failed";

export interface ThreadAutomation {
	threadId: string;
	gmailThreadId: string | null;
	enabled: boolean;
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
	enabled: boolean;
	mode: AutomationMode;
	goalPrompt: string;
	privateNotes: string;
}
