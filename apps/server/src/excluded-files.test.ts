// @ts-nocheck -- ported from the CLI suite; exercises loosely typed fakes.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as excludedFiles from "./excluded-files.js";
import * as uploader from "./session-uploader.js";

const hasZstd = typeof zlib.zstdDecompressSync === "function";
const sha = (data) => createHash("sha256").update(data).digest("hex");

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-excl-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

test("ExcludedFiles: sizes and digests filled in, privacy never hashed, the first reason wins, capped with a count", async () => {
  const root = project({ "big.log": "x".repeat(1000), ".env": "API_KEY=sk-secret\n", "img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) });
  const hashes = new Map();
  const excluded = new excludedFiles.ExcludedFiles(root, { uploadPath: (p) => p, hashes });
  excluded.add(".env", "privacy");
  excluded.add("big.log", "too_large");
  excluded.add("big.log", "gitignored");
  excluded.add("img.png", "binary", { size: 7 });
  excluded.add("node_modules/", "gitignored");
  excluded.add("gone.txt", "snapshot_cap");
  const block = await excluded.finish();
  assert.deepEqual(block.entries, [
    { path: ".env", size: 18, sha256: null, reason: "privacy" },
    { path: "big.log", size: 1000, sha256: sha("x".repeat(1000)), reason: "too_large" },
    { path: "img.png", size: 7, sha256: sha(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])), reason: "binary" },
    { path: "node_modules/", size: null, sha256: null, reason: "gitignored" },
    { path: "gone.txt", size: null, sha256: null, reason: "snapshot_cap" },
  ]);
  assert.deepEqual(block.counts, { privacy: 1, too_large: 1, binary: 1, gitignored: 1, snapshot_cap: 1 });
  assert.equal(block.truncated_count, 0);

  // A digest is reused while size, mtime and inode stay put.
  const stamp = hashes.get("big.log").stamp;
  hashes.set("big.log", { stamp, sha256: "f".repeat(64) });
  const again = new excludedFiles.ExcludedFiles(root, { uploadPath: (p) => p, hashes });
  again.add("big.log", "too_large");
  assert.equal((await again.finish()).entries[0].sha256, "f".repeat(64));

  // Past the read budget: listed without a digest.
  const thrifty = new excludedFiles.ExcludedFiles(root, { uploadPath: (p) => p, hashBudgetBytes: 10 });
  thrifty.add("big.log", "too_large");
  assert.deepEqual((await thrifty.finish()).entries[0], { path: "big.log", size: 1000, sha256: null, reason: "too_large" });

  const many = new excludedFiles.ExcludedFiles(root, { uploadPath: (p) => p });
  for (let i = 0; i < 5200; i += 1) many.add(`f${i}.bin`, "binary", { size: 1, sha256: "a".repeat(64) });
  const capped = await many.finish();
  assert.equal(capped.entries.length, 5000);
  assert.equal(capped.truncated_count, 200);
  assert.equal(capped.counts.binary, 5200);
});

async function snapshots(root, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-excl-state-"));
  const envelopes = [];
  const workspaceSync = new uploader.SessionUploader({
    stateDir,
    fallbackScanMs: 60_000,
    toolchain: false,
    capabilities: async () => ({ schema_versions: [2], canonical_trace: false }),
    upload: async (_sessionId, compressed) => {
      envelopes.push(JSON.parse(zlib.zstdDecompressSync(Buffer.from(compressed)).toString("utf8")));
      return new Response("{}", { status: 201 });
    },
    ...options,
  });
  const sessionId = "01a0dcd2-d8ee-7222-80eb-240063770433";
  workspaceSync.startSession(sessionId, "ws", root);
  await workspaceSync.idle(sessionId);
  await workspaceSync.stop();
  return envelopes;
}

test.skipIf(!hasZstd || process.platform === "win32")("a start snapshot lists what it left out, and privacy counts binaries and oversized files", async () => {
  const big = "y".repeat(5 * 1024 * 1024);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), Buffer.alloc(64)]);
  const root = project({
    "README.md": "# demo\n",
    ".gitignore": "dist/\n*.log\n.env\n",
    ".env": "API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n",
    "id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
    "data/huge.csv": big,
    "assets/logo.png": png,
    "dist/bundle.js": "built\n",
    "debug.log": "log line\n",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const envelopes = await snapshots(root);
  const start = envelopes.find((envelope) => envelope.snapshot_type === "start");
  const byPath = Object.fromEntries(start.excluded_files.entries.map((entry) => [entry.path, entry]));
  assert.deepEqual(byPath["data/huge.csv"], { path: "data/huge.csv", size: big.length, sha256: sha(big), reason: "too_large" });
  assert.deepEqual(byPath["assets/logo.png"], { path: "assets/logo.png", size: png.length, sha256: sha(png), reason: "binary" });
  assert.equal(byPath["id_rsa"].reason, "privacy");
  assert.equal(byPath["id_rsa"].sha256, null);
  assert.equal(byPath[".env"].reason, "privacy");
  assert.equal(byPath[".env"].sha256, null);
  assert.deepEqual(byPath["dist/"], { path: "dist/", size: null, sha256: null, reason: "gitignored" });
  assert.deepEqual(byPath["debug.log"], { path: "debug.log", size: 9, sha256: sha("log line\n"), reason: "gitignored" });
  assert.equal(byPath["README.md"], undefined);
  assert.equal(start.excluded_files.truncated_count, 0);
  assert.equal(start.privacy.binary_file_count, 1);
  assert.equal(start.privacy.too_large_file_count, 1);
  const text = JSON.stringify(envelopes);
  assert.ok(!text.includes("sk-proj-abcdefghij"));
  assert.ok(!text.includes("OPENSSH PRIVATE KEY-----\nabc"));
});

test.skipIf(!hasZstd || process.platform === "win32")("files over the snapshot's byte budget are listed as snapshot_cap with the manifest digest", async () => {
  const large = "z".repeat(700 * 1024);
  const root = project({ "README.md": "# demo\n", "notes/large.txt": large });
  const envelopes = await snapshots(root, { snapshotMaxBytes: 1024 * 1024 + 400 * 1024 });
  const start = envelopes.find((envelope) => envelope.snapshot_type === "start");
  const entry = start.excluded_files.entries.find((item) => item.path === "notes/large.txt");
  assert.equal(entry.reason, "snapshot_cap");
  assert.equal(entry.size, large.length);
  assert.equal(entry.sha256, start.manifest.find((item) => item.path === "notes/large.txt").sha256);
  assert.ok(start.privacy.snapshot_cap_omitted_count >= 1);
  assert.ok(!start.files.some((file) => file.path === "notes/large.txt"));
});
