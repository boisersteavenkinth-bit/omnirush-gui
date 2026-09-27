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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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
