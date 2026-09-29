import assert from "node:assert/strict";
import { test } from "node:test";

import { createExternalFetch, isLoopbackUrl, requestUrl } from "./external-fetch.mjs";

function recorder() {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init });
    return new Response("ok");
  };
  return { calls, fn };
}

test("classifies loopback targets", () => {
  for (const url of ["http://127.0.0.1:8787/x", "http://localhost:8090/omnirush/v1", "http://[::1]:3000/", "http://127.4.5.6/", new URL("http://localhost/")]) {
    assert.equal(isLoopbackUrl(url), true, String(url));
  }
  for (const url of ["https://omnirush.ai/omnirush/v1", "https://localhost.example/", "http://10.0.0.2/", "not a url", null]) {
    assert.equal(isLoopbackUrl(url), false, String(url));
  }
  assert.equal(requestUrl(new Request("https://omnirush.ai/a")), "https://omnirush.ai/a");
});

test("requests off the machine go through Electron's net.fetch without cookies", async () => {
  const net = recorder();
  const node = recorder();
  const externalFetch = createExternalFetch({ net: { fetch: net.fn }, nodeFetch: node.fn });

  await externalFetch(new URL("https://omnirush.ai/omnirush/v1/device/authorize"), { method: "POST", body: "{}" });
  await externalFetch("https://omnirush.ai/omnirush/v1/me", { credentials: "include" });

  assert.equal(node.calls.length, 0);
  assert.deepEqual(net.calls.map((call) => call.input), [
    "https://omnirush.ai/omnirush/v1/device/authorize",
    "https://omnirush.ai/omnirush/v1/me",
  ]);
  assert.equal(net.calls[0].init.credentials, "omit");
  assert.equal(net.calls[0].init.method, "POST");
  assert.equal(net.calls[1].init.credentials, "include");
});

test("loopback targets, and calls before app ready or without net, stay on Node's fetch", async () => {
  const net = recorder();
  const node = recorder();
  let ready = false;
  const externalFetch = createExternalFetch({ net: { fetch: net.fn }, nodeFetch: node.fn, isReady: () => ready });

  await externalFetch("https://omnirush.ai/");
  ready = true;
  await externalFetch("http://127.0.0.1:8787/health");
  await createExternalFetch({ net: null, nodeFetch: node.fn })("https://omnirush.ai/");

  assert.equal(net.calls.length, 0);
  assert.deepEqual(node.calls.map((call) => String(call.input)), [
    "https://omnirush.ai/",
    "http://127.0.0.1:8787/health",
    "https://omnirush.ai/",
  ]);
});

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExternalFileUpload } from "./external-fetch.mjs";

async function uploadFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "capture-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "payload.zst");
  const bytes = Buffer.alloc(256 * 1024, 73);
  await writeFile(path, bytes);
  return { path, size: bytes.length, bytes };
}

test("file upload uses Chromium credential policy and sends exact bytes", async (t) => {
  const file = await uploadFixture(t);
  const mock = recorder();
  const response = await createExternalFileUpload({ net: { fetch: mock.fn } })("https://collector.example.test/collect", {
    method: "POST", headers: { authorization: "Bearer synthetic-token" }, ...file,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(mock.calls[0].init.body, file.bytes);
  assert.equal(mock.calls[0].init.credentials, "omit");
  assert.equal(mock.calls[0].init.redirect, "error");
});

test("auth retries reopen the full file and use the refreshed bearer", async (t) => {
  const file = await uploadFixture(t);
  const calls = [];
  const net = { fetch: async (_url, init) => {
    calls.push(init);
    return new Response("{}", { status: calls.length === 1 ? 401 : 201 });
  }};
  const upload = createExternalFileUpload({ net });
  assert.equal((await upload("https://collector.example.test/collect", { method: "POST", ...file, headers: { authorization: "Bearer synthetic-old" } })).status, 401);
  assert.equal((await upload("https://collector.example.test/collect", { method: "POST", ...file, headers: { authorization: "Bearer synthetic-refreshed" } })).status, 201);
  assert.notEqual(calls[0].body, calls[1].body);
  assert.deepEqual(calls[0].body, file.bytes);
  assert.deepEqual(calls[1].body, file.bytes);
  assert.equal(calls[1].headers.authorization, "Bearer synthetic-refreshed");
});

test("native file upload accepts a no-content response", async (t) => {
  const file = await uploadFixture(t);
  const net = { fetch: async () => new Response(null, { status: 204 }) };
  const response = await createExternalFileUpload({ net })("https://collector.example.test/collect", { method: "POST", headers: {}, ...file });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("native file upload rejects truncated and oversized responses", async (t) => {
  const file = await uploadFixture(t);
  for (const broken of [true, false]) {
    let cancelled = false;
    const net = { fetch: async () => new Response(new ReadableStream({
      start(controller) {
        if (broken) controller.error(new Error("response truncated"));
        else controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() { cancelled = true; },
    })) };
    await assert.rejects(createExternalFileUpload({ net })("https://collector.example.test/collect", { method: "POST", headers: {}, ...file }), /truncated|exceeds its bound/);
    if (!broken) assert.equal(cancelled, true);
  }
});

test("native upload cancellation rejects and pre-aborted uploads never fetch", async (t) => {
  const file = await uploadFixture(t);
  let calls = 0;
  const net = { fetch: async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  }};
  const controller = new AbortController();
  const upload = createExternalFileUpload({ net });
  const result = upload("https://collector.example.test/collect", { method: "POST", headers: {}, ...file, signal: controller.signal });
  while (!calls) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  await assert.rejects(upload("https://collector.example.test/collect", { method: "POST", headers: {}, ...file, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("native upload refuses invalid sizes and changed immutable files before fetch", async (t) => {
  const file = await uploadFixture(t);
  const mock = recorder();
  const upload = createExternalFileUpload({ net: { fetch: mock.fn } });
  for (const size of [-1, 64 * 1024 * 1024 + 1, file.size - 1]) {
    await assert.rejects(upload("https://collector.example.test/collect", { method: "POST", headers: {}, ...file, size }), /bound|changed/);
  }
  assert.equal(mock.calls.length, 0);
});

test("loopback file uploads use Node duplex streaming and reopen on retries", async (t) => {
  const file = await uploadFixture(t);
  const bodies = [];
  const nodeFetch = async (_url, init) => {
    assert.equal(init.duplex, "half");
    assert.equal(init.redirect, "error");
    const bytes = await new Response(init.body).arrayBuffer();
    bodies.push(Buffer.from(bytes));
    return new Response("{}", { status: 201 });
  };
  const upload = createExternalFileUpload({ net: null, nodeFetch });
  const init = { method: "POST", headers: {}, ...file };
  await upload("http://127.0.0.1/collect", init);
  await upload("http://127.0.0.1/collect", init);
  assert.deepEqual(bodies, [file.bytes, file.bytes]);
});
