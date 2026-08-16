// Focused, dependency-free tests for the Gmail reply send transport. Bundle
// with esbuild and run under Node; never contacts Gmail.

import { buildGmailRawMessage, resolveGmailFromEmail } from "./gmail-send";
import type { GmailSendAs } from "./gmail-client";
import type { SendEmailParams } from "../email-sender";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function decodeBase64Url(value: string): string {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function replyParams(): SendEmailParams {
	return {
		to: "alice@example.net",
		from: "notes@pavlovcik.com",
		subject: "Re: Project update",
		text: "Tuesday works.",
		headers: {
			"In-Reply-To": "<incoming@example.net>",
			References: "<earlier@example.net> <incoming@example.net>",
		},
	};
}

function testRawMessageUsesResolvedFrom(): void {
	const raw = buildGmailRawMessage(replyParams(), "notes@pavlovcik.com");
	const mime = decodeBase64Url(raw).toLowerCase();
	assert(mime.startsWith("from: notes@pavlovcik.com"), "raw message starts with the resolved From");
	assert(mime.includes("from: notes@pavlovcik.com"), "From is the resolved sender alias");
	assert(mime.includes("to: alice@example.net"), "To is the reply recipient");
	assert(mime.includes("in-reply-to: <incoming@example.net>"), "In-Reply-To preserved for threading");
	assert(mime.includes("references: <earlier@example.net> <incoming@example.net>"), "References preserved for threading");
	assert(mime.includes("tuesday works."), "reply body included");
	assert(mime.includes("content-type: text/plain; charset=utf-8"), "body is plain text");
}

function testResolveUsesVerifiedAlias(): void {
	const sendAs: GmailSendAs[] = [
		{ sendAsEmail: "pavlovcik@gmail.com", isDefault: true, verificationStatus: "verified" },
		{ sendAsEmail: "agentic-inbox-test@pavlovcik.com", verificationStatus: "verified" },
		{ sendAsEmail: "unverified@pavlovcik.com", verificationStatus: "unverified" },
	];
	const resolved = resolveGmailFromEmail(
		{ ...replyParams(), from: "agentic-inbox-test@pavlovcik.com" },
		"pavlovcik@gmail.com",
		sendAs,
	);
	assert(resolved === "agentic-inbox-test@pavlovcik.com", "uses the verified send-as alias as From");
}

function testResolveFallsBackWhenAliasUnverified(): void {
	const sendAs: GmailSendAs[] = [
		{ sendAsEmail: "pavlovcik@gmail.com", isDefault: true, verificationStatus: "verified" },
		{ sendAsEmail: "notes@pavlovcik.com", verificationStatus: "unverified" },
	];
	const resolved = resolveGmailFromEmail(replyParams(), "pavlovcik@gmail.com", sendAs);
	assert(resolved === "pavlovcik@gmail.com", "unverified aliases fall back to the account");
}

function testResolveFallsBackWhenNotAnAlias(): void {
	const resolved = resolveGmailFromEmail(replyParams(), "pavlovcik@gmail.com", []);
	assert(resolved === "pavlovcik@gmail.com", "no matching alias falls back to the account");
}

function testResolveAccountRequested(): void {
	const resolved = resolveGmailFromEmail(
		{ ...replyParams(), from: "pavlovcik@gmail.com" },
		"pavlovcik@gmail.com",
		[],
	);
	assert(resolved === "pavlovcik@gmail.com", "requesting the account itself resolves to the account");
}

function testHeaderInjectionSanitized(): void {
	const raw = buildGmailRawMessage({
		to: "alice@example.net",
		from: "x@example.com",
		subject: "Fine\r\nBcc: evil@example.net",
		text: "hello",
	}, "pavlovcik@gmail.com");
	const mime = decodeBase64Url(raw);
	const headerLines = mime.split(/\r?\n/);
	assert(!headerLines.some((line) => /^bcc:/i.test(line)), "no Bcc header line is injected");
	assert(mime.includes("Subject: Fine Bcc: evil@example.net"), "subject line breaks become spaces inside the Subject value");
}

function testNonAsciiSubjectEncoded(): void {
	const raw = buildGmailRawMessage({
		to: "alice@example.net",
		from: "x@example.com",
		subject: "Café ☕",
		text: "hi",
	}, "pavlovcik@gmail.com");
	const mime = decodeBase64Url(raw);
	assert(mime.includes("Subject: =?utf-8?B?"), "non-ASCII subject is RFC 2047 encoded");
}

function testRawMessageBase64UrlEncoded(): void {
	const raw = buildGmailRawMessage({
		to: "alice@example.net",
		from: "any@example.com",
		subject: "Hi",
		text: "Hello",
	}, "pavlovcik@gmail.com");
	assert(/^[A-Za-z0-9_-]+$/.test(raw), "raw is base64url without padding characters");
	const mime = decodeBase64Url(raw);
	assert(mime.toLowerCase().includes("subject:"), "decoded message carries a subject header");
	assert(mime.includes("Hello"), "decoded message contains the plain body");
}

async function run(): Promise<void> {
	testRawMessageUsesResolvedFrom();
	testResolveUsesVerifiedAlias();
	testResolveFallsBackWhenAliasUnverified();
	testResolveFallsBackWhenNotAnAlias();
	testResolveAccountRequested();
	testRawMessageBase64UrlEncoded();
	testHeaderInjectionSanitized();
	testNonAsciiSubjectEncoded();
	console.log("gmail-send raw message tests passed");
}

void run();
