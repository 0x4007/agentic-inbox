import assert from "node:assert/strict";
import test from "node:test";
import {
	B2_BUCKET_NAME,
	B2_STORAGE_PREFIX,
	B2ObjectStore,
	getObjectStore,
	MemoryObjectStore,
	ObjectStoreConfigurationError,
	ObjectStoreKeyError,
} from "../workers/lib/b2-storage";

const textDecoder = new TextDecoder();

function urlFromFetchInput(input: RequestInfo | URL): URL {
	if (input instanceof URL) return input;
	if (input instanceof Request) return new URL(input.url);
	return new URL(input);
}

async function bodyBytes(init?: RequestInit): Promise<Uint8Array> {
	if (!init?.body) return new Uint8Array();
	return new Uint8Array(await new Response(init.body).arrayBuffer());
}

function objectKey(url: URL): string {
	const bucketPath = `/${B2_BUCKET_NAME}/`;
	assert.ok(url.pathname.startsWith(bucketPath), "objects use path-style B2 URLs");
	return decodeURIComponent(url.pathname.slice(bucketPath.length));
}

function makeStore(fetcher: typeof fetch): B2ObjectStore {
	return new B2ObjectStore({
		accessKeyId: "test-key-id",
		secretAccessKey: "test-application-key",
		endpoint: "https://s3.us-east-005.backblazeb2.com",
		fetcher,
		now: () => new Date("2026-08-14T01:02:03.000Z"),
	});
}

test("B2 requests use stable SigV4 headers without exposing the application key", async () => {
	let captured: { url: URL; init: RequestInit | undefined; bytes: Uint8Array } | null = null;
	const store = makeStore(async (input, init) => {
		captured = { url: urlFromFetchInput(input), init, bytes: await bodyBytes(init) };
		return new Response(null, { status: 200 });
	});

	await store.put("mailboxes/owner profile.json", "hello");
	assert.ok(captured);
	assert.equal(
		captured.url.toString(),
		"https://s3.us-east-005.backblazeb2.com/pavlovcik-agentic-inbox/agentic-inbox/mailboxes/owner%20profile.json",
	);
	assert.equal(textDecoder.decode(captured.bytes), "hello");
	assert.equal(
		captured.init?.headers instanceof Headers
			? captured.init.headers.get("x-amz-date")
			: null,
		"20260814T010203Z",
	);
	const headers = new Headers(captured.init?.headers);
	assert.equal(
		headers.get("x-amz-content-sha256"),
		"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	);
	const authorization = headers.get("authorization") ?? "";
	assert.equal(
		authorization,
		"AWS4-HMAC-SHA256 Credential=test-key-id/20260814/us-east-005/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=794514d3d461e0a588258671655f619e3f6456f346c72d54ae664fa691206e1c",
	);
	assert.equal(authorization.includes("test-application-key"), false);
	assert.equal(captured.url.toString().includes("test-application-key"), false);
});

test("B2 adapter preserves get, head, put, delete, and list behavior under the private prefix", async () => {
	const values = new Map<string, Uint8Array>();
	const requestedKeys: string[] = [];
	const store = makeStore(async (input, init) => {
		const url = urlFromFetchInput(input);
		const method = init?.method ?? "GET";
		if (url.searchParams.get("list-type") === "2") {
			assert.equal(url.searchParams.get("prefix"), "agentic-inbox/mailboxes/");
			const contents = [...values.entries()]
				.filter(([key]) => key.startsWith(url.searchParams.get("prefix") ?? ""))
				.map(([key, value]) => `<Contents><Key>${encodeURIComponent(key)}</Key><Size>${value.byteLength}</Size><ETag>&quot;test-etag&quot;</ETag></Contents>`)
				.join("");
			return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}<Contents><Key>other-prefix%2Fhidden</Key><Size>9</Size></Contents></ListBucketResult>`, { status: 200 });
		}

		const key = objectKey(url);
		requestedKeys.push(key);
		assert.ok(key.startsWith(B2_STORAGE_PREFIX), "every B2 object request stays under the allowed prefix");
		if (method === "PUT") {
			values.set(key, await bodyBytes(init));
			return new Response(null, { status: 200 });
		}
		if (method === "HEAD") {
			const value = values.get(key);
			return new Response(null, value
				? { status: 200, headers: { "content-length": String(value.byteLength), etag: "\"test-etag\"" } }
				: { status: 404 });
		}
		if (method === "GET") {
			const value = values.get(key);
			return value
				? new Response(value, { status: 200, headers: { "content-length": String(value.byteLength), etag: "\"test-etag\"" } })
				: new Response(null, { status: 404 });
		}
		if (method === "DELETE") {
			values.delete(key);
			return new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected method ${method}`);
	});

	await store.put("mailboxes/pavlovcik.com.json", JSON.stringify({ fromName: "Pavlovcik" }));
	const marker = await store.head("mailboxes/pavlovcik.com.json");
	assert.deepEqual(marker, { key: "mailboxes/pavlovcik.com.json", size: 24, etag: "\"test-etag\"" });
	const object = await store.get("mailboxes/pavlovcik.com.json");
	assert.ok(object);
	assert.deepEqual(await object.json(), { fromName: "Pavlovcik" });
	assert.deepEqual(
		await store.list({ prefix: "mailboxes/" }),
		{
			objects: [{ key: "mailboxes/pavlovcik.com.json", size: 24, etag: "\"test-etag\"" }],
			truncated: false,
		},
	);
	await store.delete("mailboxes/pavlovcik.com.json");
	assert.equal(await store.get("mailboxes/pavlovcik.com.json"), null);
	assert.ok(requestedKeys.length >= 5);
});

test("object keys cannot escape or duplicate the B2 storage prefix", async () => {
	let calls = 0;
	const store = makeStore(async () => {
		calls++;
		return new Response(null, { status: 200 });
	});

	await assert.rejects(() => store.put("../outside", "x"), ObjectStoreKeyError);
	await assert.rejects(() => store.get("/outside"), ObjectStoreKeyError);
	await assert.rejects(() => store.head("agentic-inbox/mailboxes/duplicate.json"), ObjectStoreKeyError);
	await assert.rejects(() => store.list({ prefix: "agentic-inbox/" }), ObjectStoreKeyError);
	assert.equal(calls, 0, "invalid logical paths do not issue signed requests");
});

test("memory mode is deterministic for local fixtures and B2 mode fails closed without secrets", async () => {
	const direct = new MemoryObjectStore();
	await direct.put("attachments/message-1/file.txt", "fixture");
	assert.equal(await (await direct.get("attachments/message-1/file.txt"))?.text(), "fixture");
	assert.deepEqual(await direct.list({ prefix: "attachments/" }), {
		objects: [{ key: "attachments/message-1/file.txt", size: 7, etag: null }],
		truncated: false,
	});
	await direct.delete(["attachments/message-1/file.txt"]);
	assert.equal(await direct.head("attachments/message-1/file.txt"), null);

	const local = getObjectStore({ EMAIL_STORAGE_MODE: "memory" });
	const localKey = "mailboxes/local-fixture-20260814.json";
	await local.put(localKey, "local fixture");
	const laterLocal = getObjectStore({ EMAIL_STORAGE_MODE: "memory" });
	assert.equal(await (await laterLocal.get(localKey))?.text(), "local fixture");
	await laterLocal.delete(localKey);

	assert.throws(
		() => getObjectStore({}),
		ObjectStoreConfigurationError,
	);
	assert.throws(
		() => getObjectStore({ EMAIL_STORAGE_MODE: "b2" }),
		ObjectStoreConfigurationError,
	);
});
