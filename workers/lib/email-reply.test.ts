// Focused, dependency-free test for buildReplyMime. Bundle this file with
// esbuild and run it under Node; it never contacts Email Service.

import { buildReplyMime } from "./email-reply";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertSubjectEncodedAs(raw: string, expectedBase64: string): void {
	// mimetext encodes subjects with RFC 2047 base64 (utf-8).
	assert(raw.includes(`Subject: =?utf-8?B?${expectedBase64}?=`), "MIME carries the reply subject (RFC 2047 encoded)");
}

function testThreadedPlainReply(): void {
	const raw = buildReplyMime({
		to: "alice@example.net",
		from: "notes@pavlovcik.com",
		subject: "Re: Project update",
		text: "Tuesday works for me.",
		headers: {
			"In-Reply-To": "<incoming@example.net>",
			References: "<earlier@example.net> <incoming@example.net>",
		},
	});
	const lower = raw.toLowerCase();
	assert(lower.includes("from: <notes@pavlovcik.com>"), "MIME sets From to the original recipient alias");
	assert(lower.includes("to: <alice@example.net>"), "MIME sets To to the original sender");
	assertSubjectEncodedAs(raw, "UmU6IFByb2plY3QgdXBkYXRl"); // "Re: Project update"
	assert(lower.includes("in-reply-to: <incoming@example.net>"), "MIME threads via In-Reply-To");
	assert(lower.includes("references: <earlier@example.net> <incoming@example.net>"), "MIME preserves the References chain");
	assert(lower.includes("tuesday works for me."), "MIME includes the reply body");
}

function testNamedFromAndHtml(): void {
	const raw = buildReplyMime({
		to: ["alice@example.net"],
		from: { email: "notes@pavlovcik.com", name: "Notes" },
		subject: "Hello",
		html: "<p>Hi</p>",
	});
	const lower = raw.toLowerCase();
	assert(lower.includes("from: <notes@pavlovcik.com>"), "named From resolves to its email address");
	assert(lower.includes("to: <alice@example.net>"), "array To resolves to the first recipient");
	assert(lower.includes("<p>hi</p>"), "MIME includes the html body");
}

async function run(): Promise<void> {
	testThreadedPlainReply();
	testNamedFromAndHtml();
	console.log("email-reply MIME builder tests passed");
}

void run();
