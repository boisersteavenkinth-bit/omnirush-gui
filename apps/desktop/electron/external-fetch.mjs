/**
 * The Electron main process's fetch for everything that leaves the machine.
 *
 * Node's global fetch, which is undici, verifies TLS against Node's own roots, so a
 * TLS-intercepting antivirus or corporate proxy whose root CA sits only in
 * the OS store (Windows certificate store, macOS keychain, the distro/NSS
 * store) fails with "self signed certificate in certificate chain". Electron's
 * net.fetch goes through Chromium's network stack instead: the OS verifier
 * and trust store, the system proxy, and the session's certificate verify
 * proc, with full certificate verification.
 *
 * Loopback targets (the embedded server, local development APIs) stay on
 * Node's fetch, where CA trust is irrelevant.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_UPLOAD_RESPONSE_BYTES = 1024 * 1024;

/**
 * @typedef {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} ExternalFetch
 */

/**
 * @param {unknown} input
 * @returns {string | null}
 */
export function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input && typeof input.url === "string") return input.url;
  return null;
}

/**
 * @param {unknown} input
 * @returns {boolean}
 */
export function isLoopbackUrl(input) {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const { hostname } = new URL(raw);
    return LOOPBACK_HOSTNAMES.has(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   net?: { fetch?: (input: string | Request, init?: RequestInit) => Promise<Response> } | null,
 *   isReady?: () => boolean,
 *   nodeFetch?: typeof globalThis.fetch,
 * }} options
 * @returns {ExternalFetch}
 */
export function createExternalFetch({ net, isReady = () => true, nodeFetch = globalThis.fetch }) {
  return function externalFetch(input, init = {}) {
    // Tests, standalone runs and anything before app ready have no net module.
    if (isLoopbackUrl(input) || typeof net?.fetch !== "function" || !isReady()) {
      return nodeFetch(input, init);
    }
    const url = input instanceof URL ? input.href : input;
    // Main-process calls authenticate with bearer tokens; never attach the
    // default session's cookies to them.
    return net.fetch(/** @type {string | Request} */ (url), { credentials: "omit", ...init });
  };
}

function abortedUpload(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function nodeFileUpload(nodeFetch, url, init) {
  if (init.signal?.aborted) throw abortedUpload(init.signal);
  const stream = createReadStream(init.path, { highWaterMark: 64 * 1024 });
  const abort = () => stream.destroy(abortedUpload(init.signal));
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await nodeFetch(url, {
      method: init.method,
      headers: init.headers,
      body: Readable.toWeb(stream),
      duplex: "half",
      signal: init.signal,
      redirect: "error",
    });
  } finally {
    init.signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}

async function boundedUploadResponse(response) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPLOAD_RESPONSE_BYTES) throw new Error("session upload response exceeds its bound");
      chunks.push(Buffer.from(value));
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * A file descriptor avoids worker/broker IPC copies. Electron's existing
 * net.fetch preserves its OS certificate verifier and system proxy.
 *
 * Keep one bounded body here: Electron 43's chunked net.request can throw
 * outside the request on interrupted uploads ("two startReading calls").
 * Node's path streams; Chromium buffers until that native issue is fixed.
 */
export function createExternalFileUpload({ net, isReady = () => true, nodeFetch = globalThis.fetch }) {
  return async function externalFileUpload(url, init) {
    if (init.signal?.aborted) throw abortedUpload(init.signal);
    if (isLoopbackUrl(url) || typeof net?.fetch !== "function" || !isReady()) {
      return boundedUploadResponse(await nodeFileUpload(nodeFetch, url, init));
    }
    if (!Number.isSafeInteger(init.size) || init.size < 0 || init.size > 64 * 1024 * 1024) {
      throw new Error("session upload file exceeds its bound");
    }
    const body = await readFile(init.path, { signal: init.signal });
    if (body.byteLength !== init.size) throw new Error("session upload file changed");
    const response = await net.fetch(url, {
      method: init.method, headers: init.headers, body, signal: init.signal,
      credentials: "omit", redirect: "error",
    });
    return boundedUploadResponse(response);
  };
}
