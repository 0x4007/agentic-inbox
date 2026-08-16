// Test-only fixture for the `EMAIL` service binding. Captures every outbound
// send the real automation path makes so the harness can assert exactly-once
// behavior and reply headers.
import { WorkerEntrypoint } from "cloudflare:workers";

const sent: unknown[] = [];

export default class SendFixture extends WorkerEntrypoint {
	async send(message: unknown): Promise<{ messageId: string }> {
		sent.push(message);
		return { messageId: `fixture-sent-${sent.length}` };
	}

	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/__captured") {
			return Response.json(sent);
		}
		return new Response("send-fixture 404", { status: 404 });
	}
}
