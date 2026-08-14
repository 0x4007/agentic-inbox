// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache-2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Private object storage for mailbox markers and attachment blobs.
 *
 * Production uses the Backblaze B2 S3-compatible API with an application key
 * restricted to this prefix. Local development and focused tests use the
 * deterministic in-memory implementation selected explicitly by configuration.
 */

export const B2_BUCKET_NAME = "pavlovcik-agentic-inbox";
export const B2_REGION = "us-east-005";
export const B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.com";
export const B2_STORAGE_PREFIX = "agentic-inbox/";

const encoder = new TextEncoder();
const EMPTY_BYTES = new Uint8Array();

export type ObjectStorePutValue = string | ArrayBuffer | ArrayBufferView;

export interface ObjectStoreObject {
	key: string;
	size: number;
	etag: string | null;
	body: ReadableStream<Uint8Array> | null;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
}

export interface ObjectStoreHead {
	key: string;
	size: number;
	etag: string | null;
}

export interface ObjectStoreListOptions {
	prefix?: string;
	cursor?: string;
	limit?: number;
}

export interface ObjectStoreListResult {
	objects: ObjectStoreHead[];
	truncated: boolean;
	cursor?: string;
}

/** The only object-store operations used by mailbox markers and attachments. */
export interface ObjectStore {
	get(key: string): Promise<ObjectStoreObject | null>;
	head(key: string): Promise<ObjectStoreHead | null>;
	put(key: string, value: ObjectStorePutValue): Promise<void>;
	delete(keys: string | readonly string[]): Promise<void>;
	list(options?: ObjectStoreListOptions): Promise<ObjectStoreListResult>;
}

export interface ObjectStorageEnv {
	EMAIL_STORAGE_MODE?: string;
	EMAIL_B2_KEY_ID?: string;
	EMAIL_B2_APPLICATION_KEY?: string;
}

export class ObjectStoreConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObjectStoreConfigurationError";
	}
}

export class ObjectStoreKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObjectStoreKeyError";
	}
}

export class ObjectStoreRequestError extends Error {
	readonly status: number;

	constructor(method: string, status: number) {
		super(`B2 object storage ${method} request failed with HTTP ${status}`);
		this.name = "ObjectStoreRequestError";
		this.status = status;
	}
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBytes(value: ObjectStorePutValue): Uint8Array {
	if (typeof value === "string") return encoder.encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
	}
	throw new TypeError("Object storage values must be strings or binary data");
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice());
			controller.close();
		},
	});
}

function parseContentLength(value: string | null): number {
	const size = Number(value);
	return Number.isFinite(size) && size >= 0 ? size : 0;
}

function responseObject(key: string, response: Response): ObjectStoreObject {
	return {
		key,
		size: parseContentLength(response.headers.get("content-length")),
		etag: response.headers.get("etag"),
		body: response.body,
		arrayBuffer: () => response.arrayBuffer(),
		text: () => response.text(),
		json: <T>() => response.json() as Promise<T>,
	};
}

function memoryObject(key: string, bytes: Uint8Array): ObjectStoreObject {
	const snapshot = bytes.slice();
	return {
		key,
		size: snapshot.byteLength,
		etag: null,
		body: streamFromBytes(snapshot),
		arrayBuffer: async () => copyArrayBuffer(snapshot),
		text: async () => new TextDecoder().decode(snapshot),
		json: async <T>() => JSON.parse(new TextDecoder().decode(snapshot)) as T,
	};
}

function normalizeLogicalPath(value: string, allowTrailingSlash: boolean): string {
	if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\0")) {
		throw new ObjectStoreKeyError("Object storage keys must be non-empty relative paths");
	}

	const trailingSlash = value.endsWith("/");
	if (trailingSlash && !allowTrailingSlash) {
		throw new ObjectStoreKeyError("Object storage keys must not end with a slash");
	}

	const segments = value.split("/");
	if (trailingSlash) segments.pop();
	if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new ObjectStoreKeyError("Object storage keys must not contain empty, dot, or parent segments");
	}

	return `${segments.join("/")}${trailingSlash ? "/" : ""}`;
}

function normalizeLogicalKey(key: string): string {
	const normalized = normalizeLogicalPath(key, false);
	if (normalized === B2_STORAGE_PREFIX.slice(0, -1) || normalized.startsWith(B2_STORAGE_PREFIX)) {
		throw new ObjectStoreKeyError("Logical object keys must not include the B2 storage prefix");
	}
	return normalized;
}

function normalizeLogicalPrefix(prefix: string): string {
	if (!prefix) return "";
	const normalized = normalizeLogicalPath(prefix, true);
	if (normalized === B2_STORAGE_PREFIX || normalized.startsWith(B2_STORAGE_PREFIX)) {
		throw new ObjectStoreKeyError("Logical object prefixes must not include the B2 storage prefix");
	}
	return normalized;
}

function rfc3986Encode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function encodeS3Path(value: string): string {
	return value.split("/").map(rfc3986Encode).join("/");
}

function canonicalQueryString(entries: readonly [string, string][]): string {
	return [...entries]
		.sort(([leftName, leftValue], [rightName, rightValue]) =>
			leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName),
		)
		.map(([name, value]) => `${rfc3986Encode(name)}=${rfc3986Encode(value)}`)
		.join("&");
}

function amzDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function shortDate(fullDate: string): string {
	return fullDate.slice(0, 8);
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	const digest = await crypto.subtle.digest("SHA-256", copyArrayBuffer(bytes));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function hmacSha256(key: Uint8Array, value: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		copyArrayBuffer(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function signingKey(secretAccessKey: string, date: string, region: string): Promise<Uint8Array> {
	const dateKey = await hmacSha256(encoder.encode(`AWS4${secretAccessKey}`), date);
	const regionKey = await hmacSha256(dateKey, region);
	const serviceKey = await hmacSha256(regionKey, "s3");
	return hmacSha256(serviceKey, "aws4_request");
}

function xmlDecode(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'");
}

function xmlText(block: string, name: string): string | null {
	const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return match ? xmlDecode(match[1]) : null;
}

function parseS3List(xml: string, physicalPrefix: string): ObjectStoreListResult {
	const objects: ObjectStoreHead[] = [];
	for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const keyText = xmlText(match[1], "Key");
		if (!keyText) continue;

		let physicalKey: string;
		try {
			physicalKey = decodeURIComponent(keyText);
		} catch {
			physicalKey = keyText;
		}
		if (!physicalKey.startsWith(physicalPrefix)) continue;

		const sizeText = xmlText(match[1], "Size");
		objects.push({
			key: physicalKey.slice(physicalPrefix.length),
			size: parseContentLength(sizeText),
			etag: xmlText(match[1], "ETag"),
		});
	}

	const truncated = xmlText(xml, "IsTruncated") === "true";
	const nextToken = xmlText(xml, "NextContinuationToken");
	return {
		objects,
		truncated,
		...(truncated && nextToken ? { cursor: nextToken } : {}),
	};
}

/** A deterministic process-local store for `wrangler dev` and focused tests. */
export class MemoryObjectStore implements ObjectStore {
	readonly values = new Map<string, Uint8Array>();

	async get(key: string): Promise<ObjectStoreObject | null> {
		const value = this.values.get(normalizeLogicalKey(key));
		return value ? memoryObject(key, value) : null;
	}

	async head(key: string): Promise<ObjectStoreHead | null> {
		const logicalKey = normalizeLogicalKey(key);
		const value = this.values.get(logicalKey);
		return value ? { key: logicalKey, size: value.byteLength, etag: null } : null;
	}

	async put(key: string, value: ObjectStorePutValue): Promise<void> {
		this.values.set(normalizeLogicalKey(key), toBytes(value).slice());
	}

	async delete(keys: string | readonly string[]): Promise<void> {
		for (const key of typeof keys === "string" ? [keys] : keys) {
			this.values.delete(normalizeLogicalKey(key));
		}
	}

	async list(options: ObjectStoreListOptions = {}): Promise<ObjectStoreListResult> {
		const prefix = normalizeLogicalPrefix(options.prefix ?? "");
		const limit = options.limit ?? 1000;
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
			throw new ObjectStoreKeyError("Object storage list limits must be integers between 1 and 1000");
		}
		const objects = [...this.values.entries()]
			.filter(([key]) => key.startsWith(prefix) && (!options.cursor || key > options.cursor))
			.sort(([left], [right]) => left.localeCompare(right));
		const page = objects.slice(0, limit).map(([key, value]) => ({ key, size: value.byteLength, etag: null }));
		const truncated = objects.length > page.length;
		return {
			objects: page,
			truncated,
			...(truncated && page.length > 0 ? { cursor: page[page.length - 1].key } : {}),
		};
	}
}

export interface B2ObjectStoreOptions {
	bucket?: string;
	region?: string;
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
	fetcher?: typeof fetch;
	now?: () => Date;
}

/**
 * Backblaze B2's S3-compatible object store. It signs only request headers;
 * it never generates or records pre-signed URLs.
 */
export class B2ObjectStore implements ObjectStore {
	readonly bucket: string;
	readonly region: string;
	readonly endpoint: URL;
	readonly prefix: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly fetcher: typeof fetch;
	readonly now: () => Date;

	constructor(options: B2ObjectStoreOptions) {
		this.bucket = options.bucket ?? B2_BUCKET_NAME;
		this.region = options.region ?? B2_REGION;
		this.endpoint = new URL(options.endpoint ?? B2_ENDPOINT);
		this.prefix = B2_STORAGE_PREFIX;
		this.accessKeyId = options.accessKeyId;
		this.secretAccessKey = options.secretAccessKey;
		this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? (() => new Date());

		if (!this.bucket || !this.region || !this.accessKeyId || !this.secretAccessKey) {
			throw new ObjectStoreConfigurationError("B2 storage requires a bucket, region, key ID, and application key");
		}
		if (this.endpoint.protocol !== "https:" || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
			throw new ObjectStoreConfigurationError("B2 storage endpoint must be a plain HTTPS URL");
		}
		if (!this.prefix.endsWith("/") || this.prefix.startsWith("/") || this.prefix.includes("..")) {
			throw new ObjectStoreConfigurationError("B2 storage prefix must be a relative path ending in a slash");
		}
	}

	async get(key: string): Promise<ObjectStoreObject | null> {
		const logicalKey = normalizeLogicalKey(key);
		const response = await this.request("GET", logicalKey);
		if (response.status === 404) return null;
		this.assertSuccess("GET", response);
		return responseObject(logicalKey, response);
	}

	async head(key: string): Promise<ObjectStoreHead | null> {
		const logicalKey = normalizeLogicalKey(key);
		const response = await this.request("HEAD", logicalKey);
		if (response.status === 404) return null;
		this.assertSuccess("HEAD", response);
		return {
			key: logicalKey,
			size: parseContentLength(response.headers.get("content-length")),
			etag: response.headers.get("etag"),
		};
	}

	async put(key: string, value: ObjectStorePutValue): Promise<void> {
		const response = await this.request("PUT", normalizeLogicalKey(key), toBytes(value));
		this.assertSuccess("PUT", response);
	}

	async delete(keys: string | readonly string[]): Promise<void> {
		for (const key of typeof keys === "string" ? [keys] : keys) {
			const response = await this.request("DELETE", normalizeLogicalKey(key));
			this.assertSuccess("DELETE", response);
		}
	}

	async list(options: ObjectStoreListOptions = {}): Promise<ObjectStoreListResult> {
		const prefix = normalizeLogicalPrefix(options.prefix ?? "");
		const limit = options.limit ?? 1000;
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
			throw new ObjectStoreKeyError("Object storage list limits must be integers between 1 and 1000");
		}

		const query: [string, string][] = [
			["encoding-type", "url"],
			["list-type", "2"],
			["max-keys", String(limit)],
			["prefix", `${this.prefix}${prefix}`],
		];
		if (options.cursor) query.push(["continuation-token", options.cursor]);
		const response = await this.request("GET", null, EMPTY_BYTES, query);
		this.assertSuccess("LIST", response);
		return parseS3List(await response.text(), this.prefix);
	}

	private physicalKey(logicalKey: string): string {
		return `${this.prefix}${logicalKey}`;
	}

	private objectUrl(logicalKey: string | null, query: readonly [string, string][]): URL {
		const url = new URL(this.endpoint.toString());
		const endpointPath = url.pathname.replace(/\/+$/, "");
		const physicalKey = logicalKey === null ? null : this.physicalKey(logicalKey);
		url.pathname = `${endpointPath}/${rfc3986Encode(this.bucket)}${physicalKey ? `/${encodeS3Path(physicalKey)}` : ""}`;
		const canonicalQuery = canonicalQueryString(query);
		url.search = canonicalQuery;
		return url;
	}

	private async request(
		method: "GET" | "HEAD" | "PUT" | "DELETE",
		logicalKey: string | null,
		body: Uint8Array = EMPTY_BYTES,
		query: readonly [string, string][] = [],
	): Promise<Response> {
		const url = this.objectUrl(logicalKey, query);
		const payloadHash = await sha256Hex(body);
		const requestDate = amzDate(this.now());
		const requestDay = shortDate(requestDate);
		const scope = `${requestDay}/${this.region}/s3/aws4_request`;
		const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
		const canonicalHeaders = [
			`host:${url.host}`,
			`x-amz-content-sha256:${payloadHash}`,
			`x-amz-date:${requestDate}`,
		].join("\n");
		const canonicalRequest = [
			method,
			url.pathname,
			url.search.slice(1),
			`${canonicalHeaders}\n`,
			signedHeaders,
			payloadHash,
		].join("\n");
		const stringToSign = [
			"AWS4-HMAC-SHA256",
			requestDate,
			scope,
			await sha256Hex(canonicalRequest),
		].join("\n");
		const signatureBytes = await hmacSha256(await signingKey(this.secretAccessKey, requestDay, this.region), stringToSign);
		const signature = [...signatureBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const headers = new Headers({
			Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": requestDate,
		});

		return this.fetcher(url, {
			method,
			headers,
			...(body.byteLength > 0 ? { body: body as unknown as BodyInit } : {}),
		});
	}

	private assertSuccess(method: string, response: Response): void {
		if (!response.ok) throw new ObjectStoreRequestError(method, response.status);
	}
}

const localFixtureStore = new MemoryObjectStore();

/**
 * Select the deployed B2 store or the explicit local fixture store.
 * Production wrangler configuration pins this to `b2`, so missing credentials
 * reject requests instead of silently storing mailbox data in worker memory.
 */
export function getObjectStore(env: ObjectStorageEnv): ObjectStore {
	const mode = env.EMAIL_STORAGE_MODE?.trim().toLowerCase();
	if (mode === "memory") return localFixtureStore;
	if (mode !== "b2") {
		throw new ObjectStoreConfigurationError("EMAIL_STORAGE_MODE must be explicitly set to 'b2' or 'memory'");
	}
	if (!env.EMAIL_B2_KEY_ID || !env.EMAIL_B2_APPLICATION_KEY) {
		throw new ObjectStoreConfigurationError("B2 storage is not configured. Set EMAIL_B2_KEY_ID and EMAIL_B2_APPLICATION_KEY.");
	}
	return new B2ObjectStore({
		accessKeyId: env.EMAIL_B2_KEY_ID,
		secretAccessKey: env.EMAIL_B2_APPLICATION_KEY,
	});
}
