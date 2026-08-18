import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { useParams } from "react-router";
import api from "~/services/api";

export default function DebugRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<string | null>(null);
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
	return <div className="max-w-2xl p-6"><h1 className="text-lg font-semibold mb-2">Debugging</h1><p className="text-sm text-kumo-subtle mb-5">Mailbox: {mailboxId}. This page is intentionally hidden from normal navigation.</p><Button onClick={run} loading={running} disabled={running}>Force Gmail inbox reimport</Button>{result && <p className="mt-4 text-sm" role="status">{result}</p>}</div>;
}
