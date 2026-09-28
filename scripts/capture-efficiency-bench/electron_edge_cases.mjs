import { app, net } from "electron";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { join, parse, resolve } from "node:path";

process.on("uncaughtException", error => { process.stderr.write("uncaught " + error.stack + "\n"); app.exit(1); });
process.on("unhandledRejection", error => { process.stderr.write("unhandled " + String(error.stack || error) + "\n"); app.exit(1); });
const entry = fileURLToPath(import.meta.url);
const args = process.argv.slice(process.argv.findIndex(arg => !arg.startsWith("-") && resolve(arg) === entry) + 1);
const [adapterPath, fixture, output, profile] = args;
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("host-resolver-rules", "MAP capture-bench.example.test 127.0.0.1");
app.whenReady().then(async () => {
  const { createExternalFileUpload } = await import(adapterPath);
  const upload = createExternalFileUpload({ net });
  const size = (await stat(fixture)).size;
  let redirected = 0, earlyBytes = 0, cancelController;
  const server = createServer((req, res) => {
    req.on("error", () => {});
    if (req.url === "/redirect-target") { redirected += 1; res.end("{}"); return; }
    if (req.url === "/redirect") { req.resume(); res.writeHead(302, { location: "/redirect-target" }); res.end(); return; }
    if (req.url === "/oversize") { req.resume(); res.writeHead(201); res.end(Buffer.alloc(1024 * 1024 + 1)); return; }
    if (req.url === "/truncated") { req.resume(); res.writeHead(201, { "content-length": "1024" }); res.write("{"); setTimeout(() => res.destroy(), 5); return; }
    if (req.url === "/cancel") { req.on("data", () => cancelController.abort()); return; }
    if (req.headers.authorization !== "Bearer synthetic-refreshed") {
      req.on("data", chunk => { earlyBytes += chunk.length; req.pause(); setTimeout(() => req.resume(), Math.max(1, chunk.length / (4 * 1024 * 1024) * 1000)); });
      res.writeHead(401, { "content-type": "application/json" }); res.end('{"detail":"expired"}'); return;
    }
    const digest = createHash("sha256"); let bytes = 0;
    req.on("data", chunk => { bytes += chunk.length; digest.update(chunk); });
    req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ bytes, sha256: digest.digest("hex") })); });
    req.on("error", () => res.destroy());
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://capture-bench.example.test:" + server.address().port;
  const init = { method: "POST", path: fixture, size, headers: { authorization: "Bearer synthetic-old" } };
  const attempt = (path, options = init) => upload(origin + path, { ...options, signal: options.signal ?? AbortSignal.timeout(15000) });
  const rejection = error => { assert.notEqual(error.name, "TimeoutError"); return true; };
  const progress = name => process.stderr.write("checking " + name + "\n");
  try {
    progress("authentication response");
    assert.equal((await attempt("/upload")).status, 401);
    progress("authenticated retry");
    const retry = await attempt("/upload", { ...init, headers: { authorization: "Bearer synthetic-refreshed" } });
    assert.equal(retry.status, 201);
    const body = await retry.json();
    assert.equal(body.bytes, size);
    const fixturePath = parse(fixture);
    assert.equal(body.sha256, (await readFile(join(fixturePath.dir, fixturePath.name + ".sha256"), "utf8")).trim());
    // Chromium may finish sending the body before delivering an auth response.
    // The retry must reopen and transmit the complete unchanged file.
    progress("redirect refusal");
    await assert.rejects(attempt("/redirect"), rejection);
    assert.equal(redirected, 0);
    progress("truncated response");
    await assert.rejects(attempt("/truncated"), rejection);
    progress("response byte bound");
    await assert.rejects(attempt("/oversize"), /exceeds its bound/);
    progress("cancellation");
    cancelController = new AbortController();
    await assert.rejects(upload(origin + "/cancel", { ...init, signal: cancelController.signal }), { name: "AbortError" });
    await writeFile(output, JSON.stringify({
      electron: process.versions.electron, bytes: size, sha256: body.sha256, early_request_body_bytes: earlyBytes,
      assertions: { auth_response_returned: true, retry_reopens_entire_file: true, redirects_refused: true,
        truncated_response_rejected: true, response_size_bounded: true, cancellation: true },
    }, null, 2));
  } finally {
    progress("cleanup");
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  app.quit();
}).catch(error => { process.stderr.write(String(error.stack || error) + "\n"); app.exit(1); });
