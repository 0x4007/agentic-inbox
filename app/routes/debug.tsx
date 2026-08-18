import { Button, Input } from "@cloudflare/kumo";
import { useState } from "react";
import { useParams } from "react-router";
import api from "~/services/api";

export default function DebugRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [messageId, setMessageId] = useState("");
	const regenerate = async () => {
		if (!messageId.trim()) return;
		setRunning(true); setResult(null);
		try {
			const response = await api.regenerateGmailDraft(messageId.trim());
			setResult(response.status === "drafted" ? `Draft regenerated: ${response.replyId ?? "created"}` : `Result: ${response.status}${response.error ? ` — ${response.error}` : ""}`);
		} catch (error) { setResult(error instanceof Error ? error.message : "Draft regeneration failed"); }
		finally { setRunning(false); }
	};
	const run = async () => {
		if (running) return;
		setRunning(true); setResult(null);
		try {
			let token: string | undefined; let threads = 0; let messages = 0;
			do {
				const page = await api.backfillGmail(token, true);
				threads += page.threadCount; messages += page.importedMessageCount;
				token = page.nextPageToken ?? undefined;
			} while (token);
			setResult(`${threads} inbox threads reimported; ${messages} new messages`);
		} catch (error) {
			setResult(error instanceof Error ? error.message : "Gmail reimport failed");
		} finally { setRunning(false); }
	};
	return <div className="max-w-2xl p-6 space-y-6"><div><h1 className="text-lg font-semibold mb-2">Debugging</h1><p className="text-sm text-kumo-subtle">Mailbox: {mailboxId}. Hidden from normal navigation.</p></div><section className="rounded-lg border border-kumo-line p-4"><h2 className="font-medium mb-2">Gmail import</h2><Button onClick={run} loading={running} disabled={running}>Force Gmail inbox reimport</Button></section><section className="rounded-lg border border-kumo-line p-4"><h2 className="font-medium mb-2">Regenerate draft</h2><p className="text-xs text-kumo-subtle mb-3">Paste a Gmail/local message ID, such as gmail:…</p><div className="flex gap-2"><Input aria-label="Message ID" value={messageId} onChange={(event) => setMessageId(event.target.value)} placeholder="gmail:message-id" /><Button onClick={regenerate} loading={running} disabled={running || !messageId.trim()}>Regenerate draft</Button></div></section>{result && <p className="text-sm" role="status">{result}</p>}</div>;
}
