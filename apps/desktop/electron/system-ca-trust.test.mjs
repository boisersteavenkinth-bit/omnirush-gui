// Node's own TLS (fetch/undici, https, and child processes) behind a
// TLS-intercepting proxy whose root is only in the OS trust store.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import tls from "node:tls";
import { promisify } from "node:util";

import { resolveSystemCaEnv } from "./runtime.mjs";
import { commandEnv, extendDefaultCaCertificates, isUsableCaCertificate } from "./system-ca.mjs";

const UNPARSABLE = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";

async function interceptionFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "omnirush-intercept-"));
  const run = (...args) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  await writeFile(path.join(directory, "root.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.csr", "-subj", "/CN=Test Interception Root");
  run("x509", "-req", "-in", "root.csr", "-signkey", "root.key", "-out", "root.pem", "-days", "2", "-sha256", "-extfile", "root.ext");
  await writeFile(path.join(directory, "leaf.ext"), "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n");
  run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "root.pem", "-CAkey", "root.key", "-set_serial", "9", "-out", "leaf.pem", "-days", "1", "-sha256", "-extfile", "leaf.ext");
  const root = await readFile(path.join(directory, "root.pem"), "utf8");
  const leaf = await readFile(path.join(directory, "leaf.pem"), "utf8");
  // Interception products serve their root in the chain.
  const server = https.createServer({ key: await readFile(path.join(directory, "leaf.key")), cert: `${leaf}${root}` }, (_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  return { directory, root: root.trim(), url: `https://localhost:${typeof address === "object" && address ? address.port : 0}/`, close: () => server.close() };
}

test("extendDefaultCaCertificates keeps the parsable roots when one certificate is rejected", () => {
  const calls = [];
  const tlsModule = {
    getCACertificates: () => ["bundled"],
    setDefaultCACertificates(certs) {
      calls.push(certs);
      if (certs.includes("bad")) throw new Error("PEM routines");
    },
  };
  const result = extendDefaultCaCertificates(tlsModule, ["good-1", "bad", "good-2"], (pem) => pem !== "bad");
  assert.deepEqual(result, { applied: true, certificates: ["good-1", "good-2"], rejected: 1, error: null });
  assert.deepEqual(calls.at(-1), ["bundled", "good-1", "good-2"]);
});

test("isUsableCaCertificate rejects what the TLS library cannot parse", async () => {
  const fixture = await interceptionFixture();
  fixture.close();
  assert.equal(isUsableCaCertificate(fixture.root), true);
  assert.equal(isUsableCaCertificate(UNPARSABLE), false);
});

test("Node fetch and Node child processes trust an OS-store interception root after startup", async () => {
  const fixture = await interceptionFixture();
  try {
    // The reported failure: Node's bundled roots reject the intercepted chain.
    await assert.rejects(fetch(fixture.url), (/** @type {any} */ error) => /self[- ]signed certificate in certificate chain/i.test(String(error?.cause?.message)));

    const userDataDir = await mkdtemp(path.join(tmpdir(), "omnirush-system-ca-"));
    const logs = [];
    const childEnv = await resolveSystemCaEnv({
      tlsModule: tls,
      userDataDir,
      parentEnv: {},
      logInfo: (message) => logs.push(String(message)),
      // The OS store as enumerated: one entry BoringSSL/OpenSSL refuses, and the interception root.
      loadPlatformCertificates: async () => [UNPARSABLE, fixture.root],
      platformSourceName: "test-store",
      chainRepair: { disabled: true },
    });

    const response = await fetch(fixture.url);
    assert.equal(await response.text(), "ok");
    assert.ok(logs.some((line) => /main-process TLS trusts \d+ OS certificates \(skipped 1 /.test(line)), logs.join("\n"));

    const bundle = await readFile(String(childEnv.NODE_EXTRA_CA_CERTS), "utf8");
    assert.ok(bundle.includes(fixture.root));
    assert.ok(!bundle.includes(UNPARSABLE));

    // Asynchronous: the fixture server runs on this event loop.
    const child = await promisify(execFile)(process.execPath, ["-e", `fetch(${JSON.stringify(fixture.url)}).then(async (r) => console.log(await r.text()), (e) => { console.log(e.cause?.message); process.exitCode = 1; })`], {
      env: { ...process.env, ...childEnv },
      encoding: "utf8",
    });
    assert.equal(child.stdout.trim(), "ok", child.stdout + child.stderr);
  } finally {
    fixture.close();
  }
});

test("trust-store commands do not inherit a PowerShell 7 module path", () => {
  assert.deepEqual(commandEnv({ Path: "C:\\Windows", PSModulePath: "C:\\pwsh7\\Modules", SystemRoot: "C:\\Windows" }), { Path: "C:\\Windows", SystemRoot: "C:\\Windows" });
  assert.deepEqual(commandEnv({ PSMODULEPATH: "x", HOME: "/home/u" }), { HOME: "/home/u" });
});
