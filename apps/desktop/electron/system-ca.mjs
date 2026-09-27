import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";

const COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024;
const WINDOWS_CERT_BEGIN = "-----OMNIRUSH-CERTIFICATE-----";
const WINDOWS_CERT_END = "-----END-OMNIRUSH-CERTIFICATE-----";
const PEM_CERT_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * @typedef {(command: string, args: string[], windowsHide: boolean) => Promise<string | null>} SystemCaCommandRunner
 */

/**
 * @typedef {Object} SystemCaSource
 * @property {string} name
 * @property {number} count
 */

/**
 * @typedef {Object} SystemCaBundle
 * @property {string[]} certificates
 * @property {SystemCaSource[]} sources
 */

/**
 * @typedef {Object} SystemCaPlatformLoader
 * @property {string} name
 * @property {() => Promise<string[]>} load
 */

/**
 * @typedef {Object} SystemCaLoaders
 * @property {() => string[]} runtime
 * @property {SystemCaPlatformLoader} platform
 */

/**
 * @param {Iterable<string>} certs
 * @returns {string[]}
 */
export function dedupeCertificates(certs) {
  const seen = new Set();
  const out = [];
  for (const cert of certs) {
    const trimmed = String(cert ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
export function pemFromBase64(value) {
  const base64 = value.replace(/\s+/g, "");
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return null;
  }
  const lines = base64.match(/.{1,64}/g);
  if (!lines) return null;
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * @param {string} output
 * @returns {string[]}
 */
export function parseWindowsPowerShellCertificates(output) {
  const certs = [];
  const pattern = new RegExp(`${WINDOWS_CERT_BEGIN}\\s*([A-Za-z0-9+/=\\r\\n]+?)\\s*${WINDOWS_CERT_END}`, "g");
  for (const match of output.matchAll(pattern)) {
    const pem = pemFromBase64(match[1] ?? "");
    if (pem) certs.push(pem);
  }
  return dedupeCertificates(certs);
}

/**
 * @param {string} output
 * @returns {string[]}
 */
export function parseDarwinSecurityCertificates(output) {
  const certs = [];
  for (const match of output.matchAll(PEM_CERT_PATTERN)) {
    certs.push(match[0]);
  }
  return dedupeCertificates(certs);
}

/**
 * The environment for the trust-store commands. Windows PowerShell 5.1 cannot
 * load its own modules, and so has no Cert: drive, with the PSModulePath that
 * PowerShell 7 exports to anything started from it (the app launched from a
 * pwsh terminal); without the variable it rebuilds its default module path.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function commandEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} windowsHide
 * @returns {Promise<string | null>}
 */
export function runCommand(command, args, windowsHide) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide, env: commandEnv(process.env) });
    } catch {
      resolve(null);
      return;
    }

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, COMMAND_TIMEOUT_MS);

    /** @param {string | null} value */
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      const next = `${output}${String(chunk)}`;
      if (next.length > OUTPUT_LIMIT_CHARS) {
        child.kill();
        finish(null);
        return;
      }
      output = next;
    });
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code === 0 ? output : null));
  });
}

/**
 * @param {SystemCaCommandRunner} [commandRunner]
 * @returns {Promise<string[]>}
 */
export async function loadWindowsSystemCertificates(commandRunner = runCommand) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$stores = @('Cert:\\LocalMachine\\Root', 'Cert:\\LocalMachine\\CA', 'Cert:\\CurrentUser\\Root', 'Cert:\\CurrentUser\\CA')
foreach ($store in $stores) {
  Get-ChildItem -Path $store -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.RawData) {
      '${WINDOWS_CERT_BEGIN}'
      [Convert]::ToBase64String($_.RawData)
      '${WINDOWS_CERT_END}'
    }
  }
}
`;
  const output = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], true);
  return output ? parseWindowsPowerShellCertificates(output) : [];
}

// Admin-controlled keychains only. `find-certificate` ignores trust settings, so
// including the user-writable login keychain would let any local process widen
// what the desktop trusts; user-domain roots go through NODE_EXTRA_CA_CERTS.
export const DARWIN_KEYCHAINS = [
  "/Library/Keychains/System.keychain",
  "/System/Library/Keychains/SystemRootCertificates.keychain",
];

/**
 * @param {SystemCaCommandRunner} [commandRunner]
 * @returns {Promise<string[]>}
 */
export async function loadDarwinSystemCertificates(commandRunner = runCommand) {
  const output = await commandRunner("security", ["find-certificate", "-a", "-p", ...DARWIN_KEYCHAINS], false);
  return output ? parseDarwinSecurityCertificates(output) : [];
}

/**
 * @param {NodeJS.Platform} platform
 * @param {SystemCaCommandRunner} [commandRunner]
 * @returns {SystemCaPlatformLoader}
 */
export function systemPlatformCertificateLoader(platform = process.platform, commandRunner = runCommand) {
  if (platform === "win32") return { name: "windows-cert-stores", load: () => loadWindowsSystemCertificates(commandRunner) };
  if (platform === "darwin") return { name: "macos-keychains", load: () => loadDarwinSystemCertificates(commandRunner) };
  return { name: "platform-stores", load: async () => [] };
}

/**
 * Every source is additive. Returning the runtime list as soon as it is
 * non-empty skips the thorough platform enumeration, which is where corporate
 * roots often live on managed Windows and macOS machines.
 *
 * @param {SystemCaLoaders} loaders
 * @returns {Promise<SystemCaBundle>}
 */
export async function resolveSystemCaBundle(loaders) {
  let runtimeCerts = [];
  try {
    runtimeCerts = loaders.runtime();
  } catch {
    runtimeCerts = [];
  }
  const platformCerts = await loaders.platform.load().catch(() => []);

  return {
    certificates: dedupeCertificates([...runtimeCerts, ...platformCerts]),
    sources: [
      { name: "runtime", count: runtimeCerts.length },
      { name: loaders.platform.name, count: platformCerts.length },
    ],
  };
}

/**
 * @param {SystemCaSource[]} sources
 * @returns {string}
 */
export function summarizeSystemCaSources(sources) {
  if (sources.length === 0) return "no OS trust sources returned certificates";
  return sources.map((source) => `${source.name}=${source.count}`).join(" ");
}

/**
 * @typedef {Object} DefaultCaTlsModule
 * @property {(type?: string) => string[]} [getCACertificates]
 * @property {(certificates: string[]) => void} [setDefaultCACertificates]
 */

/**
 * @typedef {Object} DefaultCaResult
 * @property {boolean} applied Whether Node's default CA list now includes the additions.
 * @property {string[]} certificates The additions that were accepted (all of them, or the parsable ones).
 * @property {number} rejected Additions dropped because the TLS library could not parse them.
 * @property {string | null} error Why the defaults could not be extended, when they could not.
 */

/**
 * Whether the TLS library accepts a PEM certificate as a trust anchor.
 * @param {string} pem
 * @returns {boolean}
 */
export function isUsableCaCertificate(pem) {
  try {
    new X509Certificate(pem);
    tls.createSecureContext({ ca: pem });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extends Node's default CA list (what fetch/undici, https and tls.connect
 * verify against when no `ca` is given) with the OS trust store, in this
 * process. setDefaultCACertificates rejects the whole list when any one
 * certificate does not parse, and OS stores (the Windows CA/Root stores in
 * particular) can hold certificates that BoringSSL refuses; those are dropped
 * one by one rather than losing every OS root, including the antivirus or
 * corporate proxy root the user depends on.
 *
 * @param {DefaultCaTlsModule | undefined} tlsModule
 * @param {string[]} additions
 * @param {(pem: string) => boolean} [isUsable]
 * @returns {DefaultCaResult}
 */
export function extendDefaultCaCertificates(tlsModule, additions, isUsable = isUsableCaCertificate) {
  if (additions.length === 0) return { applied: false, certificates: [], rejected: 0, error: null };
  if (typeof tlsModule?.getCACertificates !== "function" || typeof tlsModule?.setDefaultCACertificates !== "function") {
    return { applied: false, certificates: additions, rejected: 0, error: "tls.setDefaultCACertificates is unavailable" };
  }
  let base;
  try {
    const defaults = tlsModule.getCACertificates("default");
    base = Array.isArray(defaults) ? defaults : [];
  } catch (error) {
    return { applied: false, certificates: additions, rejected: 0, error: String(error?.message ?? error) };
  }
  try {
    tlsModule.setDefaultCACertificates(dedupeCertificates([...base, ...additions]));
    return { applied: true, certificates: additions, rejected: 0, error: null };
  } catch {
    // One or more unparsable certificates; keep the rest.
  }
  const usable = additions.filter((pem) => isUsable(pem));
  const rejected = additions.length - usable.length;
  if (usable.length === 0) return { applied: false, certificates: [], rejected, error: "no parsable certificates" };
  try {
    tlsModule.setDefaultCACertificates(dedupeCertificates([...base, ...usable]));
    return { applied: true, certificates: usable, rejected, error: null };
  } catch (error) {
    return { applied: false, certificates: usable, rejected, error: String(error?.message ?? error) };
  }
}
