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
