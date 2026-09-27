// Test-only, for throwaway CI runners (it edits the hosts file and the OS
// trust store): checks the desktop's HTTPS paths behind a TLS-intercepting
// proxy whose root CA is only in the OS trust store, as antivirus HTTPS
// scanning and corporate proxies install it.
//   Windows: LocalMachine\Root (and CurrentUser\Root when it imports without
//            a prompt); needs an elevated shell.
//   macOS:   the System keychain, as a trusted root; needs passwordless sudo.
//   Linux:   /usr/local/share/ca-certificates; needs passwordless sudo and Xvfb.
//
//   node apps/desktop/scripts/system-ca/os-check.mjs [--compare-ref origin/main]
//
// Writes results to apps/desktop/dist-electron/system-ca/*.json. Exits 1 when
// the build under test fails a check; the compare ref is only reported.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const outDir = path.join(desktopDir, "dist-electron", "system-ca");
const workDir = path.join(os.tmpdir(), "omnirush-system-ca-check");
const compareIndex = process.argv.indexOf("--compare-ref");
const compareRef = compareIndex >= 0 ? process.argv[compareIndex + 1] : "origin/main";
const opensslCandidates = [process.env.OPENSSL_BIN, "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"].filter(Boolean);
const openssl = opensslCandidates.find((candidate) => existsSync(candidate)) ?? "openssl";

const isWindows = process.platform === "win32";

const log = (...args) => console.log("[system-ca]", ...args);
// Windows PowerShell 5.1 cannot load its own modules (no Cert: drive) with the
// PSModulePath that a PowerShell 7 parent (the runner's shell) exports.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: cleanEnv }).trim();

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const caDir = path.join(workDir, "intercept");

// 1. The comparison build's electron sources, next to the build under test so
//    they resolve the same node_modules.
const compareDir = path.join(desktopDir, "electron-compare");
rmSync(compareDir, { recursive: true, force: true });
let compareAvailable = false;
try {
  execFileSync("git", ["-C", repoDir, "fetch", "-q", "--depth", "1", "origin", compareRef.replace(/^origin\//, "")], { stdio: "inherit" });
  const archive = path.join(workDir, "compare.tar");
  execFileSync("git", ["-C", repoDir, "archive", "-o", archive, "FETCH_HEAD", "apps/desktop/electron"], { stdio: "inherit" });
  const extract = path.join(workDir, "compare");
  mkdirSync(extract, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", extract], { stdio: "inherit" });
  cpSync(path.join(extract, "apps", "desktop", "electron"), compareDir, { recursive: true });
  compareAvailable = true;
} catch (error) {
  log("compare ref unavailable:", error.message);
}

// 2. Root + leaf for omnirush.ai.
execFileSync(process.execPath, [path.join(here, "intercept-proxy.mjs"), "--dir", caDir, "--certs-only"], { stdio: "inherit", env: { ...process.env, OPENSSL_BIN: openssl } });
const rootCer = path.join(caDir, "root.cer");
const rootPem = path.join(caDir, "root.pem");
const thumbprint = isWindows ? ps(`(New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${rootCer}')).Thumbprint`) : null;

const sudo = (...args) => execFileSync("sudo", ["-n", ...args], { stdio: "inherit" });

// 3. Hosts file -> proxy on 127.0.0.1:443.
if (isWindows) {
  const hostsFile = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts");
  appendFileSync(hostsFile, "\r\n127.0.0.1 omnirush.ai\r\n");
  spawnSync("ipconfig", ["/flushdns"], { stdio: "ignore" });
} else {
  sudo("sh", "-c", "printf '\\n127.0.0.1 omnirush.ai\\n' >> /etc/hosts");
  if (process.platform === "darwin") {
    spawnSync("sudo", ["-n", "dscacheutil", "-flushcache"], { stdio: "ignore" });
    spawnSync("sudo", ["-n", "killall", "-HUP", "mDNSResponder"], { stdio: "ignore" });
  }
}
const proxyLog = path.join(outDir, "proxy.log");
const proxyArgs = [path.join(here, "intercept-proxy.mjs"), "--dir", caDir, "--port", "443"];
const proxy = isWindows
  ? spawn(process.execPath, proxyArgs, { stdio: ["ignore", "pipe", "pipe"] })
  : spawn("sudo", ["-n", "-E", process.execPath, ...proxyArgs], { stdio: ["ignore", "pipe", "pipe"] });
proxy.stdout.on("data", (chunk) => appendFileSync(proxyLog, chunk));
proxy.stderr.on("data", (chunk) => appendFileSync(proxyLog, chunk));
await new Promise((resolve) => setTimeout(resolve, 3000));
log(readFileSync(proxyLog, "utf8").trim());

const electronBin = createRequire(path.join(desktopDir, "package.json"))("electron");
log("electron:", electronBin, existsSync(electronBin));
function smoke(label, electronDir, extraEnv = {}) {
  const out = path.join(outDir, `${label}.json`);
  // Linux runners have no display: Electron needs one even without windows.
  const [command, args] = process.platform === "linux"
    ? ["xvfb-run", ["-a", electronBin, "--no-sandbox", path.join(here, "smoke.mjs")]]
    : [electronBin, [path.join(here, "smoke.mjs")]];
  const result = spawnSync(command, args, {
    cwd: desktopDir,
    env: { ...cleanEnv, ...extraEnv, SMOKE_URL: "https://omnirush.ai/", SMOKE_ROOT_PEM: rootPem, SMOKE_ELECTRON_DIR: electronDir, SMOKE_OUT: out },
    encoding: "utf8",
    timeout: 180_000,
  });
  log(`${label}:\n${result.stdout}${result.stderr}${result.error ? `\nspawn error: ${result.error.message}` : ""}`);
  return existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { fatal: `no result (exit ${result.status})` };
}

function runScenario(store, extraEnv = {}) {
  const results = {};
  if (compareAvailable) results.compare = smoke(`${store}-compare`, compareDir, extraEnv);
  results.branch = smoke(`${store}-branch`, path.join(desktopDir, "electron"), extraEnv);
  return results;
}

/**
 * A root CA that Windows (and OpenSSL) accept but BoringSSL, Electron's TLS
 * library, refuses: its version field is BER- rather than DER-encoded (a
 * non-minimal length). Legacy and vendor certificates in real Windows stores
 * have such encodings.
 */
function berEncodedRoot() {
  const dir = path.join(workDir, "ber");
  mkdirSync(dir, { recursive: true });
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ber.key", "-out", "ber-src.pem", "-subj", "/CN=OmniRush.ai Test BER-encoded Root", "-days", "3"], { cwd: dir, stdio: "ignore" });
  const der = Buffer.from(readFileSync(path.join(dir, "ber-src.pem"), "utf8").replace(/-----[^-]+-----|\s+/g, ""), "base64");
  const version = der.indexOf(Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]));
  if (version < 0) throw new Error("unexpected certificate layout");
  let ber = Buffer.concat([der.subarray(0, version), Buffer.from([0xa0, 0x04, 0x02, 0x81, 0x01, 0x02]), der.subarray(version + 5)]);
  for (const offset of [0, 4]) {
    if (ber[offset] !== 0x30 || ber[offset + 1] !== 0x82) throw new Error("unexpected certificate layout");
    ber.writeUInt16BE(ber.readUInt16BE(offset + 2) + 1, offset + 2);
  }
  const file = path.join(dir, "ber.cer");
  writeFileSync(file, ber);
  return file;
}

const scenarios = {};

if (isWindows) {
// 4a. CurrentUser\Root. Adding a root there can raise a confirmation dialog,
//     so the import runs in a job with a timeout and is verified afterwards.
const currentUser = ps(`
$job = Start-Job -ScriptBlock { param($p)
  $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($p)
  $s = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
  $s.Open('ReadWrite'); $s.Add($c); $s.Close() } -ArgumentList '${rootCer}'
if (-not (Wait-Job $job -Timeout 45)) { Stop-Job $job }
[bool](Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${thumbprint}' })`);
log("CurrentUser\\Root import:", currentUser);
if (currentUser === "True") {
  scenarios.currentUserRoot = runScenario("currentuser");
  ps(`Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${thumbprint}' } | Remove-Item`);
}

// 4b. LocalMachine\Root (where antivirus products install their root).
execFileSync("certutil", ["-addstore", "-f", "Root", rootCer], { stdio: "ignore" });
log("LocalMachine\\Root import:", ps(`[bool](Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq '${thumbprint}' })`));
scenarios.localMachineRoot = runScenario("localmachine");

// 4c. The same, plus a root in LocalMachine\Root that BoringSSL cannot parse.
try {
  const ber = berEncodedRoot();
  execFileSync("certutil", ["-addstore", "-f", "Root", ber], { stdio: "ignore" });
  const berThumb = ps(`(New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${ber}')).Thumbprint`);
  log("BER-encoded root in LocalMachine\\Root:", ps(`[bool](Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq '${berThumb}' })`));
  scenarios.localMachineRootWithUnparsableCert = runScenario("localmachine-unparsable");
  execFileSync("certutil", ["-delstore", "Root", berThumb], { stdio: "ignore" });
} catch (error) {
  log("BER scenario unavailable:", error.message);
}

} else if (process.platform === "darwin") {
  // 4. The System keychain, trusted as a root (where MDM, antivirus and proxy
  //    installers put theirs).
  sudo("security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", rootPem);
  scenarios.systemKeychain = runScenario("system-keychain");
} else {
  // 4. The distribution store (/etc/ssl), which Node reads as the system store.
  sudo("cp", rootPem, "/usr/local/share/ca-certificates/omnirush-test-intercept.crt");
  sudo("update-ca-certificates");
  scenarios.distributionStore = runScenario("distribution-store");
}

// 5. The same, with NODE_EXTRA_CA_CERTS already set (to an unrelated CA
//     file, as developer tooling or IT often leave it).
{
  const unrelated = path.join(workDir, "unrelated-ca.pem");
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(workDir, "unrelated.key"), "-out", unrelated, "-subj", "/CN=Unrelated Corporate CA", "-days", "3"], { stdio: "ignore" });
  scenarios.withNodeExtraCaCerts = runScenario("extra-ca", { NODE_EXTRA_CA_CERTS: unrelated });
}

if (isWindows) proxy.kill(); else spawnSync("sudo", ["-n", "pkill", "-f", "intercept-proxy.mjs"], { stdio: "ignore" });
const intercepted = existsSync(path.join(caDir, "intercepted.txt")) ? readFileSync(path.join(caDir, "intercepted.txt"), "utf8").trim() : "0";

const REQUIRED = ["app-external-fetch", "node-fetch-after-app-ca-setup", "child-node-fetch"];
let failed = false;
const summary = { intercepted: Number(intercepted), scenarios: {} };
for (const [name, runs] of Object.entries(scenarios)) {
  summary.scenarios[name] = {};
  for (const [which, result] of Object.entries(runs)) {
    const checks = Object.fromEntries(Object.entries(result.checks ?? {}).map(([key, value]) => [key, value.ok ? "ok" : `FAILED: ${value.error ?? value.output}`]));
    summary.scenarios[name][which] = { checks, rootInNodeSystemStore: result.systemRootInNodeSystemStore, rootInPlatformStore: result.systemRootInPlatformStore, bulkSecureContext: result.bulkSecureContext, unparsablePlatformCerts: result.unparsablePlatformCerts, logs: result.logs, fatal: result.fatal };
    if (which !== "branch") continue;
    if (result.checks?.["node-fetch-bundled"]?.ok !== false) { failed = true; log(`${name}: the proxy was not in the path`); }
    for (const key of REQUIRED) if (!result.checks?.[key]?.ok) failed = true;
    if (result.checks?.["child-bun-fetch"] && !result.checks["child-bun-fetch"].ok) failed = true;
  }
}
writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(failed ? 1 : 0);
