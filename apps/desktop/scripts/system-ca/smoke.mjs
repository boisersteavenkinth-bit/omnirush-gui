// Test-only: run as the Electron main entry (`electron smoke.mjs`) behind
// intercept-proxy.mjs. It reports which of the desktop's HTTPS paths accept
// a TLS-intercepting root that only the OS trust store knows about.
//
// env: SMOKE_URL        https URL routed through the proxy
//      NODE_EXTRA_CA_CERTS optional, as a user or IT may have set it
//      SMOKE_ROOT_PEM   the proxy's root (for diagnostics only; never trusted directly)
//      SMOKE_ELECTRON_DIR  apps/desktop/electron of the build under test
//      SMOKE_OUT        JSON results file
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

import { app, net, session } from "electron";

const target = process.env.SMOKE_URL || "https://omnirush.ai/";
const electronDir = path.resolve(process.env.SMOKE_ELECTRON_DIR || path.join(import.meta.dirname, "..", "..", "electron"));
const out = process.env.SMOKE_OUT || path.join(process.cwd(), "system-ca-smoke.json");
const rootPem = process.env.SMOKE_ROOT_PEM && existsSync(process.env.SMOKE_ROOT_PEM)
  ? readFileSync(process.env.SMOKE_ROOT_PEM, "utf8").trim()
  : null;
const results = { target, electronDir, platform: process.platform, versions: { electron: process.versions.electron, node: process.versions.node }, checks: {}, logs: [] };

function describe(error) {
  const cause = error?.cause;
  return [error?.message, cause?.code, cause?.message].filter(Boolean).join(" | ");
}

async function check(name, run) {
  try {
    const response = await run();
    await response.arrayBuffer().catch(() => null);
    results.checks[name] = { ok: true, status: response.status };
  } catch (error) {
    results.checks[name] = { ok: false, error: describe(error) };
  }
  console.log(`[smoke] ${name}: ${JSON.stringify(results.checks[name])}`);
}

function fingerprint(pem) {
  try { return new X509Certificate(pem).fingerprint256; } catch { return null; }
}

app.whenReady().then(async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "omnirush-system-ca-smoke-"));
  const rootPrint = rootPem ? fingerprint(rootPem) : null;
  try {
    // Node's fetch with the bundled roots only: the reported failure.
    await check("node-fetch-bundled", () => fetch(target, { cache: "no-store" }));
    // Chromium's own stack (OS verifier, OS store, system proxy), in a session of its own
    // so that its verification result is not cached for the app's default session.
    await check("electron-net-fetch", () => session.fromPartition("smoke-raw-chromium").fetch(target, { cache: "no-store", credentials: "omit" }));

    const systemCerts = (() => { try { return tls.getCACertificates("system"); } catch { return []; } })();
    results.systemRootInNodeSystemStore = rootPrint ? systemCerts.some((pem) => fingerprint(pem) === rootPrint) : null;
    results.nodeSystemCount = systemCerts.length;

    const systemCa = await import(pathToFileURL(path.join(electronDir, "system-ca.mjs")).href);
    const platformCerts = await systemCa.systemPlatformCertificateLoader(process.platform).load().catch(() => []);
    results.platformCount = platformCerts.length;
    results.systemRootInPlatformStore = rootPrint ? platformCerts.some((pem) => fingerprint(pem) === rootPrint) : null;
    results.unparsablePlatformCerts = platformCerts.filter((pem) => fingerprint(pem) === null).length;
    try {
      tls.createSecureContext({ ca: [...systemCerts, ...platformCerts] });
      results.bulkSecureContext = "ok";
    } catch (error) {
      results.bulkSecureContext = describe(error);
    }

    // The desktop's own main-process CA setup, exactly as the build under test runs it.
    const runtime = await import(pathToFileURL(path.join(electronDir, "runtime.mjs")).href);
    // As main.mjs does at startup, before any request: Chromium also anchors on the OS roots
    // the app enumerated (on Linux, Chromium reads NSS rather than /etc/ssl).
    if (typeof runtime.createSystemCaCertificateVerifyProc === "function") {
      session.defaultSession.setCertificateVerifyProc(runtime.createSystemCaCertificateVerifyProc([...systemCerts, ...platformCerts]));
    }
    const childEnv = await runtime.resolveSystemCaEnv({
      userDataDir,
      // As the app passes it: a NODE_EXTRA_CA_CERTS from the user's environment is honored.
      parentEnv: process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {},
      logInfo: (message) => results.logs.push(String(message)),
    });
    results.childEnv = childEnv;
    await check("node-fetch-after-app-ca-setup", () => fetch(target, { cache: "no-store" }));

    const externalFetchModule = path.join(electronDir, "external-fetch.mjs");
    if (existsSync(externalFetchModule)) {
      const { createExternalFetch } = await import(pathToFileURL(externalFetchModule).href);
      const externalFetch = createExternalFetch({ net });
      await check("app-external-fetch", () => externalFetch(new URL(target), { method: "GET" }));
    }

    // A Node child with the environment the desktop gives its sidecars.
    const child = spawnSync(process.execPath, ["-e", `fetch(${JSON.stringify(target)}).then((r) => { console.log("status", r.status); }, (e) => { console.log("error", e.message, e.cause && e.cause.message); process.exitCode = 1; })`], {
      env: { ...process.env, ...childEnv, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    results.checks["child-node-fetch"] = { ok: child.status === 0, output: `${child.stdout}${child.stderr}`.trim().slice(0, 400) };
    console.log(`[smoke] child-node-fetch: ${JSON.stringify(results.checks["child-node-fetch"])}`);

    // A Bun child (the engine sidecar's runtime) with the same environment.
    const bun = spawnSync(process.platform === "win32" ? "bun.exe" : "bun", ["-e", `fetch(${JSON.stringify(target)}).then((r) => { console.log("status", r.status); }, (e) => { console.log("error", e.message); process.exitCode = 1; })`], {
      env: { ...process.env, ...childEnv },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (!bun.error) {
      results.checks["child-bun-fetch"] = { ok: bun.status === 0, output: `${bun.stdout}${bun.stderr}`.trim().slice(0, 400) };
      console.log(`[smoke] child-bun-fetch: ${JSON.stringify(results.checks["child-bun-fetch"])}`);
    }
  } catch (error) {
    results.fatal = describe(error);
  }
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  app.quit();
});
