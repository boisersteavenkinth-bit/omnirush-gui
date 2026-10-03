import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { FakeArchiveServer } from "./fake-archive-server.js";
import { SessionArchiver } from "./index.js";
import { outsideArchivePath, outsideSourcePath } from "./outside.js";
import { cleanupTempDirs, manifestOf, openArchive, tempDir } from "./test-helpers.js";
import { TouchedPathStore } from "./touched.js";
import { recordTurnFiles, shellPathCandidates } from "./turn-files.js";

// Files outside the session's workspace that the agent touches are archived
// byte for byte under `__outside__/<absolute path>`, with the archive's
// exclusions; every turn records the files it read as "artifact" events
// (the CLI's test/capture-outside.test.js).

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encoded = (absolute: string) => `__outside__/${absolute.slice(1)}`;

async function write<T extends string | Buffer>(file: string, content: T): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return content;
}

async function gitProject(): Promise<string> {
  const root = await tempDir("outside-root");
  await write(join(root, "README.md"), "# project\n");
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "add", "."]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  return root;
}

function archiver(server: FakeArchiveServer, stateDir: string) {
  return new SessionArchiver({
    gatewayUrl: server.gatewayUrl,
    accessToken: server.token,
    fetch: server.respond,
    stateDir,
    excludedDirs: [stateDir],
    retry: { baseMs: 1, maxMs: 2, attempts: 2 },
    touchedFlushMs: 5,
  });
}

/** The members of the archive uploaded last, by name. */
async function lastArchive(server: FakeArchiveServer) {
  const object = server.objects().at(-1)!.object!;
  const members = await openArchive(object);
  return { names: new Map(members.map((member) => [member.name, member.content])), manifest: manifestOf(members) as { files: Array<{ path: string; sha256: string }>; deleted?: string[]; excluded: Record<string, number> } };
}

describe("files outside the workspace", () => {
  test("absolute paths encode under __outside__ and decode back; anything else is refused", () => {
    expect(outsideArchivePath("/tmp/fixtures/sample.bin", false)).toBe("__outside__/tmp/fixtures/sample.bin");
    expect(outsideSourcePath("__outside__/tmp/fixtures/sample.bin", false)).toBe("/tmp/fixtures/sample.bin");
    expect(outsideArchivePath("C:\\Users\\me\\data.xlsx", true)).toBe("__outside__/C/Users/me/data.xlsx");
    expect(outsideSourcePath("__outside__/C/Users/me/data.xlsx", true)).toBe("C:\\Users\\me\\data.xlsx");
    for (const bad of ["relative/file", "/", "/tmp/../etc", "/tmp//x", "/a\0b"]) expect(outsideArchivePath(bad, false)).toBeNull();
    for (const bad of ["\\\\server\\share\\x", "C:relative", "C:\\a\\b:stream"]) expect(outsideArchivePath(bad, true)).toBeNull();
  });

  test("the touched-path store keeps outside paths apart from workspace ones, across a restart", async () => {
    const dir = await tempDir("outside-store");
    const open = () => new TouchedPathStore(dir, { ready: async () => undefined, modeOf: async () => "tracked", log: () => undefined, flushMs: 60_000 });
    const first = open();
    first.track("ses_outside_store");
    first.note("ses_outside_store", "src/a.py");
    first.note("ses_outside_store", "/tmp/elsewhere/data.bin");
    first.note("ses_outside_store", "../escape.txt");
    await first.flush();
    const second = open();
    expect([...(await second.snapshot("ses_outside_store"))]).toEqual(["src/a.py"]);
    expect([...(await second.outside("ses_outside_store"))]).toEqual(["/tmp/elsewhere/data.bin"]);
  });

  test("shell commands name their path arguments, quoted paths inside scripts too", () => {
    const found = shellPathCandidates(`xxd /tmp/f/sample.bin | head; cp "/tmp/my dir/a.wav" out.wav && python3 -c "import pickle; pickle.load(open('/tmp/f/model.pkl','rb'))" --out=/tmp/f/x.gz > ~/report.txt 2>/dev/null`);
    for (const expected of ["/tmp/f/sample.bin", "/tmp/my dir/a.wav", "out.wav", "/tmp/f/model.pkl", "/tmp/f/x.gz", "~/report.txt"]) expect(found).toContain(expected);
  });

  test("files the agent read, wrote or named in a command are archived byte for byte; credentials, caches and symlinks are not", async () => {
    const root = await gitProject();
    const away = await tempDir("outside-files");
    const home = join(away, "home");
    const server = new FakeArchiveServer();
    const stateDir = await tempDir("outside-state");
    const archive = archiver(server, stateDir);
    const sessionId = "ses_outside_capture_1";
    expect((await archive.captureBase(sessionId, root)).status).toBe("queued");

    const sample = await write(join(away, "fixtures", "sample.bin"), randomBytes(70_000));
    const wav = await write(join(away, "fixtures", "clip.wav"), randomBytes(5_000));
    const env = await write(join(away, "fixtures", ".env"), "API_KEY=sk-secret\n");
    const sshKey = await write(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    await write(join(away, "proj", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await write(join(home, ".cache", "pip", "blob.bin"), randomBytes(100));
    await symlink(join(away, "fixtures", "sample.bin"), join(away, "fixtures", "link.bin"));
    const written = join(away, "out", "written.bin");
    const bytesWritten = await write(written, randomBytes(9_000));
    const messages = [{
      info: { id: "msg_1", role: "assistant" },
      parts: [
        { type: "tool", tool: "read", state: { status: "completed", input: { filePath: join(away, "fixtures", "sample.bin") } } },
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: written, content: "..." } } },
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: `file ${away}/fixtures/clip.wav ${away}/fixtures/.env ~/.ssh/id_ed25519 ${away}/proj/node_modules/dep/index.js ~/.cache/pip/blob.bin ${away}/fixtures/link.bin ${away}/fixtures` } } },
      ],
    }];
    const reported: string[] = [];
    await recordTurnFiles({
      sessionId,
      root,
      messages,
      home,
      collector: { recordTrace: () => undefined },
      archive: { pathTouched: (id, file) => { reported.push(file); archive.recordTouched(id, file); } },
    });
    expect(new Set(reported)).toEqual(new Set([join(away, "fixtures", "sample.bin"), written, join(away, "fixtures", "clip.wav")]));

    expect((await archive.captureDelta(sessionId, root, 1)).status).toBe("queued");
    await archive.drain();
    const delta = await lastArchive(server);
    expect(delta.names.get(encoded(join(away, "fixtures", "sample.bin")))!.equals(sample)).toBe(true);
    expect(delta.names.get(encoded(written))!.equals(bytesWritten)).toBe(true);
    expect(delta.names.get(encoded(join(away, "fixtures", "clip.wav")))!.equals(wav)).toBe(true);
    expect(delta.manifest.files.find((entry) => entry.path === encoded(written))!.sha256).toBe(sha256(bytesWritten));
    const names = [...delta.names.keys()];
    expect(names.some((name) => /\.ssh|\.env|node_modules|\.cache|link\.bin/.test(name))).toBe(false);
    expect([...delta.names.values()].some((content) => content.equals(Buffer.from(env)) || content.equals(Buffer.from(sshKey)))).toBe(false);

    // Reported directly, the excluded ones still stay out; a changed outside file goes again, a gone one is deleted.
    for (const file of [join(away, "fixtures", ".env"), join(home, ".ssh", "id_ed25519"), join(away, "fixtures", "link.bin")]) archive.recordTouched(sessionId, file);
    await writeFile(written, "changed\n");
    expect((await archive.captureDelta(sessionId, root, 2)).status).toBe("queued");
    await archive.drain();
    const next = await lastArchive(server);
    expect([...next.names.keys()].filter((name) => name.startsWith("__outside__/"))).toEqual([encoded(written)]);
    expect(next.manifest.excluded.credential).toBeGreaterThanOrEqual(2);
    await rm(written);
    expect((await archive.captureDelta(sessionId, root, 3)).status).toBe("queued");
    await archive.drain();
    expect((await lastArchive(server)).manifest.deleted).toEqual([encoded(written)]);
    await archive.stop();
  });

  test("a read-only turn records the files it read, inside and outside the workspace, with size and sha256", async () => {
    const root = await tempDir("outside-ro-root");
    const away = await tempDir("outside-ro-away");
    const readme = await write(join(root, "README.md"), "# readme\n");
    await write(join(root, ".env.local"), "TOKEN=x\n");
    const data = await write(join(away, "data.sqlite"), randomBytes(4096));
    const tar = await write(join(away, "bundle.tar.gz"), randomBytes(2048));
    const messages = [{
      info: { id: "m", role: "assistant" },
      parts: [
        { type: "tool", tool: "read", state: { input: { filePath: join(root, "README.md") } } },
        { type: "tool", tool: "read", state: { input: { filePath: ".env.local" } } },
        { type: "tool", tool: "read", state: { input: { filePath: join(away, "data.sqlite") } } },
        { type: "tool", tool: "bash", state: { input: { command: `tar -tzf ${away}/bundle.tar.gz` } } },
      ],
    }];
    const traced: Array<{ type: string; data: Record<string, unknown> }> = [];
    await recordTurnFiles({ sessionId: "ses_read_only_1", root, messages, collector: { recordTrace: (_id, type, data) => traced.push({ type, data: data as Record<string, unknown> }) }, archive: null });
    expect(traced.every((event) => event.type === "artifact")).toBe(true);
    const byPath = new Map(traced.map((event) => [event.data.path, event.data]));
    expect(byPath.get("README.md")).toEqual({ path: "README.md", sha256: sha256(readme), bytes: readme.length, access: "read" });
    expect(byPath.get(encoded(join(away, "data.sqlite")))).toEqual({ path: encoded(join(away, "data.sqlite")), sha256: sha256(data), bytes: data.length, access: "read", outside: true });
    expect(byPath.get(encoded(join(away, "bundle.tar.gz")))!.sha256).toBe(sha256(tar));
    expect(byPath.get(encoded(join(away, "bundle.tar.gz")))!.access).toBe("shell");
    expect(byPath.has(".env.local")).toBe(false);
    expect(traced).toHaveLength(3);
  });
});
