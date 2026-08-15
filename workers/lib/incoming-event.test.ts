// Focused regression test: the runtime email message exposes raw/rawSize/from/
// to as WebIDL getters on the prototype, not own enumerable properties. A
// naive `{ ...event }` spread silently drops them. Bundle with esbuild and run
// under Node.

import { toIncomingEmailEvent } from "./incoming-event";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
	if (actual !== expected) {
		throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
	}
}

/** Build a host-like object: fields live on the prototype as getters only. */
function hostLikeEvent(): {
	event: unknown;
	raw: ReadableStream;
	rawSize: number;
	from: string;
	to: string;
	forwardCalls: string[];
} {
	const raw = new ReadableStream();
	const forwardCalls: string[] = [];
	const proto = {
		get raw() {
			return raw;
		},
		get rawSize() {
			return 12712;
		},
		get from() {
			return "pavlovcik@gmail.com";
		},
		get to() {
			return "agentic-inbox-test@pavlovcik.com";
		},
		forward(recipient: string) {
			forwardCalls.push(recipient);
			return Promise.resolve({ messageId: `fwd-${recipient}` });
		},
	};
	const event = Object.create(proto);
	// A spread of this object must not carry the getter-backed fields.
	equal(Object.keys(event).length, 0, "host-like event has no own enumerable fields");
	return { event, raw, rawSize: 12712, from: "pavlovcik@gmail.com", to: "agentic-inbox-test@pavlovcik.com", forwardCalls };
}

function testGetterFieldsSurviveCopy(): void {
	const { event, raw, rawSize, from, to, forwardCalls } = hostLikeEvent();
	const sendReply = async () => ({ messageId: "reply-1" });
	const shaped = toIncomingEmailEvent(event as never, sendReply);

	equal(shaped.raw, raw, "raw stream is preserved by field copy");
	equal(shaped.rawSize, rawSize, "rawSize is preserved by field copy");
	equal(shaped.from, from, "from is preserved by field copy");
	equal(shaped.to, to, "to is preserved by field copy");
	equal(typeof shaped.forward, "function", "forward is preserved by field copy");
	equal(shaped.sendReply, sendReply, "sendReply capability is attached");
	assert(!("get raw" in Object.getOwnPropertyNames(shaped)), "shaped event is a plain object, not a host object");
}

function testSpreadDropsGetterFields(): void {
	const { event, raw } = hostLikeEvent();
	const spread = { ...(event as Record<string, unknown>) };
	assert(spread.raw === undefined, "plain spread drops prototype getters (the bug this guards against)");
	// The helper is the only supported way to shape the runtime event.
	const shaped = toIncomingEmailEvent(event as never);
	equal(shaped.raw, raw, "helper recovers the getter-backed raw stream");
}

async function run(): Promise<void> {
	testGetterFieldsSurviveCopy();
	testSpreadDropsGetterFields();
	console.log("incoming-event getter regression tests passed");
}

void run();
