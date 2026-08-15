// Test-only fixture gateway. Stands in for the ai.ubq.fi model endpoint and
// captures every forward so the local runtime harness can assert exactly-once
// behavior against the real Worker runtime.
const captured: { type: string; payload: unknown }[] = [];

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__captured") {
			return Response.json(captured);
		}
		if (url.pathname === "/__captured-forward") {
			const payload = await request.json().catch(() => null);
			captured.push({ type: "forward", payload });
			return Response.json({ captured: captured.length });
		}
		if (url.pathname.endsWith("/v1/chat/completions")) {
			return Response.json({
				choices: [{ message: { content: "Thanks for your message. I will get back to you shortly." } }],
			});
		}
		return new Response("gateway 404", { status: 404 });
	},
};
