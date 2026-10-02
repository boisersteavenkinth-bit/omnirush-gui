import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { inRegenerableDir } from "../session-uploader.js";
import { FakeArchiveServer } from "./fake-archive-server.js";
import { ARCHIVE_STATE_DIRECTORY, SessionArchiver, type SessionArchiverOptions } from "./index.js";
import { cleanupTempDirs, manifestOf, openArchive, tempDir } from "./test-helpers.js";
import { findLockfiles } from "./touched.js";

// What a session must carry to be rebuilt as a reproducible task (the CLI's
// test/capture-reproducible.test.js): the files the agent touched, binaries
// and gitignored ones included, and every lockfile, but never the regenerable
// folders (node_modules, virtualenvs, build output) that are reinstalled from
// those lockfiles.

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
}

/** The CLI test's tree: an ignored output folder, an ignored Cargo.lock, a nested lockfile and node_modules. */
async function tree(root: string): Promise<void> {
  const write = async (relative: string, content: string | Buffer) => {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), content);
  };
  await write(".gitignore", "outputs/\nnode_modules/\nCargo.lock\n");
  await write("src/main.rs", "fn main() {}\n");
  await write("outputs/plot.png", PNG);
  await write("outputs/untouched.txt", "an ignored file the agent never touched\n");
  await write("Cargo.lock", "# ignored lockfile\n");
  await write("web/pnpm-lock.yaml", "lockfileVersion: 9\n");
  await write("node_modules/dep/package-lock.json", "{}\n");
  await write("node_modules/dep/index.js", "module.exports = 1;\n");
}

function archiver(server: FakeArchiveServer, stateDir: string, options: Partial<SessionArchiverOptions> = {}) {
  return new SessionArchiver({
    gatewayUrl: server.gatewayUrl,
    accessToken: server.token,
    fetch: server.respond,
    stateDir,
    retry: { baseMs: 1, maxMs: 2, attempts: 2 },
    touchedFlushMs: 5,
    ...options,
  });
}

describe("reproducible-task capture", () => {
  test("regenerable folders are recognised by any path component, .git content too", () => {
    for (const regenerable of ["node_modules/a/b.js", "a/.venv/lib/x.py", "pkg/target/debug/app", "x/.git/HEAD", "dist/out.js"]) {
      expect(inRegenerableDir(regenerable)).toBe(true);
    }
    for (const kept of ["outputs/plot.png", "docs/build.md", "node_modules", "src/target.rs"]) {
      expect(inRegenerableDir(kept)).toBe(false);
    }
  });

  test("lockfiles are found at any depth outside .git and the regenerable folders", async () => {
    const root = await tempDir("repro");
    await tree(root);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "yarn.lock"), "not a project lockfile\n");
    expect(await findLockfiles(root)).toEqual(["Cargo.lock", "web/pnpm-lock.yaml"]);
  });

  test("a whole-folder archive keeps the ignored files the agent touched and every lockfile, never the regenerable folders", async () => {
    const root = await tempDir("repro");
    await tree(root);
    await git(root, "init", "-q", "-b", "main");
    await git(root, "add", ".gitignore", "src/main.rs", "web/pnpm-lock.yaml");
    await git(root, "commit", "-q", "-m", "init");
    const server = new FakeArchiveServer();
    const state = await tempDir("state");
    const subject = archiver(server, state);
    const id = "ses_repro_whole_folder";

    expect(await subject.captureBase(id, root)).toMatchObject({ status: "queued", kind: "base" });
    expect((await subject.drain()).uploaded).toBe(1);
    const base = await openArchive(server.objects()[0]!.object!);
    const baseNames = base.map((member) => member.name);
    // The gitignored lockfile is archived in full; the ignored folders are not.
    expect(base.find((member) => member.name === "Cargo.lock")?.content.toString()).toBe("# ignored lockfile\n");
    expect(baseNames).toEqual(expect.arrayContaining(["src/main.rs", "web/pnpm-lock.yaml", ".gitignore"]));
    expect(baseNames.some((name) => name.startsWith("outputs/") || name.startsWith("node_modules/"))).toBe(false);
    // Entries stay in archive order after the merge.
    const files = (manifestOf(base).files as Array<{ path: string }>).map((file) => file.path);
    expect(files).toEqual([...files].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));

    // The agent writes a gitignored binary and touches a file in node_modules.
    const plot = Buffer.concat([PNG, Buffer.from([0, 1, 2, 255])]);
    await writeFile(join(root, "outputs/plot.png"), plot);
    subject.recordTouched(id, "outputs/plot.png");
    subject.recordTouched(id, "node_modules/dep/index.js");
    expect(await subject.captureDelta(id, root, 1)).toMatchObject({ status: "queued", kind: "delta" });
    expect((await subject.drain()).uploaded).toBe(1);
    const delta = await openArchive(server.objects()[1]!.object!);
    expect(delta.map((member) => member.name)).toEqual(["__omnirush__/manifest.json", "outputs/plot.png"]);
    expect(sha256(delta[1]!.content)).toBe(sha256(plot));
    expect(manifestOf(delta).deleted ?? []).toEqual([]);

    // The next turn changes nothing the agent touched: the touched file stays in the chain.
    await writeFile(join(root, "outputs/untouched.txt"), "edited, still never touched\n");
    expect(await subject.captureDelta(id, root, 2)).toEqual({ status: "skipped", reason: "unchanged" });
    for (const object of server.objects()) {
      const names = (await openArchive(object.object!)).map((member) => member.name);
      expect(names).not.toContain("outputs/untouched.txt");
      expect(names.some((name) => name.startsWith("node_modules/"))).toBe(false);
    }
    await subject.stop();
    // The whole-folder chain kept its touched paths, and keeps them across a restart.
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "touched"))).toHaveLength(1);
    const restarted = archiver(server, state);
    await restarted.start();
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "touched"))).toHaveLength(1);
    // The restarted app still holds the touched binary: no delta deletes it.
    expect(await restarted.captureDelta(id, root, 3)).toEqual({ status: "skipped", reason: "unchanged" });
    await restarted.stop();
  });

  test("a touched-files chain archives the gitignored files the agent touched and every lockfile, never node_modules", async () => {
    const home = await tempDir("home");
    const root = join(home, "report");
    await mkdir(root);
    await tree(root);
    const server = new FakeArchiveServer();
    server.policy = { touched_files: true };
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: home } });
    const id = "ses_repro_touched";

    expect(await subject.captureBase(id, root)).toEqual({ status: "skipped", reason: "unchanged" });
    subject.recordTouched(id, "outputs/plot.png");
    subject.recordTouched(id, "node_modules/dep/index.js");
    subject.recordTouched(id, "node_modules/dep/package-lock.json");
    expect(await subject.captureDelta(id, root, 1)).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect((await subject.drain()).uploaded).toBe(1);
    const members = await openArchive(server.objects()[0]!.object!);
    expect(members.map((member) => member.name)).toEqual(["__omnirush__/manifest.json", "Cargo.lock", "outputs/plot.png", "web/pnpm-lock.yaml"]);
    expect(members[2]!.content.equals(PNG)).toBe(true);
    expect(manifestOf(members)).toMatchObject({ scope: "touched", workspace: { marker: "touched" } });
    await subject.stop();
  });
});
