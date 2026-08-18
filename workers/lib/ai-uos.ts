// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache-2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A deliberately small, non-streaming client for the private ai.ubq.fi
 * gateway. This module has no provider fallback: callers either receive one
 * validated reply body from gpt-5.6-terra or a typed failure.
 */

export const AI_UOS_CHAT_COMPLETIONS_URL = "https://ai.ubq.fi/v1/chat/completions";
export const AI_UOS_MODEL = "gpt-5.6-terra";
export const AI_UOS_DEFAULT_TIMEOUT_MS = 15_000;
export const AI_UOS_MAX_REPLY_TOKENS = 600;
export const AI_UOS_MAX_REPLY_CHARACTERS = 4_000;

export type AiUosMessage = {
	role: "system" | "user";
	content: string;
};

export type AiUosFailureKind = "configuration" | "timeout" | "network" | "http" | "malformed";

export class AiUosError extends Error {
	constructor(
		readonly kind: AiUosFailureKind,
		message: string,
	) {
		super(message);
		this.name = "AiUosError";
	}
}

export interface AiUosClientOptions {
	authToken?: string;
	fetcher?: typeof fetch;
	endpoint?: string;
	timeoutMs?: number;
	maxTokens?: number;
	maxReplyCharacters?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function extractReplyBody(payload: unknown): string | null {
	if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
		return null;
	}
	const firstChoice = payload.choices[0];
	if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return null;
	return typeof firstChoice.message.content === "string" ? firstChoice.message.content : null;
}

/**
 * Accept only a plain text email body. Header-like model output is rejected
 * rather than being converted into a sendable message with altered metadata.
 */
export function validateAiUosReplyBody(
	body: string,
	maxReplyCharacters = AI_UOS_MAX_REPLY_CHARACTERS,
): string {
	const normalized = body.replace(/\r\n?/g, "\n").trim();
	if (!normalized) {
		throw new AiUosError("malformed", "Model returned an empty reply body");
	}
	if (normalized.length > maxReplyCharacters) {
		throw new AiUosError("malformed", "Model reply exceeds the email reply limit");
	}
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
		throw new AiUosError("malformed", "Model reply contains unsupported control characters");
	}
	if (/^(?:to|from|cc|bcc|subject|in-reply-to|references|message-id)\s*:/im.test(normalized)) {
		throw new AiUosError("malformed", "Model reply contains email headers");
	}
	return normalized;
}

export class AiUosChatClient {
	readonly #authToken: string | undefined;
	readonly #fetcher: typeof fetch;
	readonly #endpoint: string;
	readonly #timeoutMs: number;
	readonly #maxTokens: number;
	readonly #maxReplyCharacters: number;

	constructor(options: AiUosClientOptions = {}) {
		this.#authToken = options.authToken;
		// Never store the global fetch unbound: workerd rejects calls where the
		// receiver is not globalThis, so wrap it the same way b2-storage does.
		this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
		this.#endpoint = options.endpoint ?? AI_UOS_CHAT_COMPLETIONS_URL;
		this.#timeoutMs = clampInteger(options.timeoutMs ?? AI_UOS_DEFAULT_TIMEOUT_MS, 1_000, 60_000);
		this.#maxTokens = clampInteger(options.maxTokens ?? AI_UOS_MAX_REPLY_TOKENS, 1, AI_UOS_MAX_REPLY_TOKENS);
		this.#maxReplyCharacters = clampInteger(
			options.maxReplyCharacters ?? AI_UOS_MAX_REPLY_CHARACTERS,
			1,
			AI_UOS_MAX_REPLY_CHARACTERS,
		);
	}

	async complete(messages: readonly AiUosMessage[]): Promise<string> {
		if (!this.#authToken?.trim()) {
			throw new AiUosError("configuration", "UOS_AUTH_TOKEN is not configured");
		}
		if (messages.length === 0) {
			throw new AiUosError("malformed", "A model request needs at least one message");
		}

		const abortController = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			abortController.abort();
		}, this.#timeoutMs);

		let response: Response;
		try {
			response = await this.#fetcher(this.#endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#authToken}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					model: AI_UOS_MODEL,
					messages,
					temperature: 0.1,
					max_tokens: this.#maxTokens,
					stream: false,
				}),
				signal: abortController.signal,
			});
		} catch (error) {
			if (timedOut) {
				throw new AiUosError("timeout", "Model generation timed out");
			}
			const detail = error instanceof Error ? error.message : String(error);
			throw new AiUosError("network", `Model generation could not reach the provider: ${detail}`);
		} finally {
			clearTimeout(timeout);
		}

		if (response.status === 429) {
			const retryAfter = Number(response.headers.get("retry-after") ?? "1");
			await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter * 1000, 250), 5000)));
			response = await this.#fetcher(this.#endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.#authToken}`, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ model: AI_UOS_MODEL, messages, temperature: 0.1, max_tokens: this.#maxTokens, stream: false }),
				signal: abortController.signal,
			});
		}
		if (!response.ok) {
			throw new AiUosError("http", `Model provider returned HTTP ${response.status}`);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new AiUosError("malformed", "Model provider returned invalid JSON");
		}

		const replyBody = extractReplyBody(payload);
		if (replyBody === null) {
			throw new AiUosError("malformed", "Model provider returned no reply body");
		}

		return validateAiUosReplyBody(replyBody, this.#maxReplyCharacters);
	}
}
