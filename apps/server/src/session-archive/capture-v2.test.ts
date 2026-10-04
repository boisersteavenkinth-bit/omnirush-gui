import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { filterUploadDiff, collectGitBlock, SessionUploader, utf8DiffText } from "../session-uploader.js";
import { AttachmentStore, attachmentArchivePath, attachmentsFromMessages, homeRelativePath, promptMentions } from "./attachments.js";
import { binaryReason } from "./binary.js";
import { isGitConfigPath, scrubGitConfig } from "./git-scrub.js";
import { SessionArchiver } from "./index.js";
import { ProjectArchiveLifecycle, type ProjectArchiver } from "./lifecycle.js";
import { captureGitEnv, discoverRepos, parsePorcelainZ, stripRemoteCredentials } from "./repos.js";
import { openSealedBuffer, SEAL_ALG, sealKeyring } from "./seal.js";
import { readTar, type TarMemberRead } from "./test-helpers.js";
import { sseFrames, toolStartSession, watchToolStarts } from "./tool-start.js";

// Capture v2 – byte-exact project state, the desktop's side. The CLI runs the
// same modules (omnirush-cli assets/extensions/omnirush/capture/session-archive)
// against the same vectors (__fixtures__/capture_v2_vectors.json).

type Json = Record<string, unknown>;
type Entry = { path: string; type: string; mode: number; size: number; sha256: string | null; target?: string; broken?: boolean; scrubbed?: boolean };
type StateDoc = {
  schema: string;
  archive_id: string;
  state: { kind: string; turn: number; reason?: string };
  start_capture?: string;
  repos: Array<{ path: string; position: string; archived: string; git_dir: string | null; head: string | null; branch: string | null; unborn: boolean; tracked_files: number | null; staged_files: string[]; dirty_files: Array<{ path: string; status: string }>; stash_count: number; remote: string | null; error: string | null; session_subdir?: string }>;
  excluded: Array<{ path: string; reason: string }>;
  excluded_truncated: boolean;
  scrubbed: string[];
  attachments: Array<{ path: string; message_id: string; name: string; source: string; source_path: string | null; sha256: string }>;
};

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "capture_v2_vectors.json"), "utf8"));
const cleanups: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}
function write(file: string, content: string | Buffer, mode?: number): Buffer {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

const POLICY_V2 = { all_folders: true, touched_files: true, capture_v2: true };

type Opened = { members: Map<string, TarMemberRead>; order: string[]; manifest: { schema: string; trigger?: string; turn: number; files: Entry[]; deleted?: string[]; workspace: Json; archive_id: string }; state: StateDoc | null; unstable: string[]; entry: (path: string) => Entry | undefined; bytes: (path: string) => Buffer | undefined };

function rig(policy: Json = POLICY_V2) {
  const stateDir = temp("omnirush-v2-state-");
  const keyring = sealKeyring([randomBytes(32)]);
  const { publicRaw, kid } = [...keyring.values()][0]!;
  const request = async (route: string) => route === "archives/key"
    ? Response.json({ public_key: publicRaw.toString("base64"), kid, alg: SEAL_ALG, policy })
    : new Response("{}", { status: 404 });
  const archiver = new SessionArchiver({ stateDir, request, excludedDirs: [stateDir], log: () => undefined, touchedFlushMs: 10 });
  stops.push(() => archiver.stop({ budgetMs: 1000 }));
  const open = async (result: Awaited<ReturnType<SessionArchiver["captureBase"]>>): Promise<Opened> => {
    if (result.status !== "queued") throw new Error(`not queued: ${JSON.stringify(result)}`);
    const sealed = readFileSync(join(stateDir, "omnirush-archive", "pending", `${result.archiveId}.orseal`));
    const members = readTar(zstdDecompressSync(await openSealedBuffer(sealed, keyring)));
    const byName = new Map(members.map((member) => [member.name.replace(/\/$/, ""), member]));
    const json = (name: string) => (byName.has(name) ? JSON.parse(byName.get(name)!.content.toString("utf8")) : null);
    const manifest = json("__omnirush__/manifest.json");
    return {
      members: byName,
      order: members.map((member) => member.name),
      manifest,
      state: json("__omnirush__/state.json"),
      unstable: json("__omnirush__/unstable.json")?.paths ?? [],
      entry: (path) => manifest.files.find((item: Entry) => item.path === path),
      bytes: (path) => (byName.get(path)?.typeflag === "0" ? byName.get(path)!.content : undefined),
    };
  };
  return { archiver, open };
}

describe("capture v2", () => {
  test("parity vectors: the CLI's answers for binary detection, config scrubbing, tool-start events, attachments and git parsing", () => {
    for (const item of vectors.binary) expect(binaryReason(item.path, Buffer.from(item.base64, "base64"), item.partial === true)).toBe(item.expect);
    for (const item of vectors.scrub) expect(scrubGitConfig(item.text)).toEqual(item.expect);
    for (const item of vectors.configPaths) expect(isGitConfigPath(item.path)).toBe(item.expect);
    for (const item of vectors.toolStart) expect(toolStartSession(item.payload)).toBe(item.expect);
    for (const item of vectors.sse) expect(sseFrames(item.text)).toEqual(item.expect);
    for (const item of vectors.attachmentPaths) expect(attachmentArchivePath(item.messageId, item.index, item.name)).toBe(item.expect);
    const found = attachmentsFromMessages(vectors.attachments.messages).map((source) => ({ ...source, data: source.data ? source.data.toString("base64") : null }));
    expect(found).toEqual(vectors.attachments.expect);
    for (const item of vectors.porcelain) expect(parsePorcelainZ(item.text)).toEqual(item.expect);
    for (const item of vectors.remotes) expect(stripRemoteCredentials(item.url)).toBe(item.expect);
  });

  test("#8 #4 #12: a folder without git: the start manifest before the prompt, then a byte-exact base with binaries over 4 MiB, lockfiles, modes, symlinks and the exclusions with their reasons", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-folder-");
    write(join(root, "README.md"), "# demo\n");
    const big = write(join(root, "data", "big.bin"), randomBytes(5 * 1024 * 1024 + 7));
    const pdf = write(join(root, "doc.pdf"), "%PDF-1.4\n%all ascii\n%%EOF\n");
    const lockb = write(join(root, "bun.lockb"), Buffer.concat([Buffer.from([0, 1, 2]), randomBytes(4 * 1024 * 1024 + 100)]));
    write(join(root, "run.sh"), "#!/bin/sh\necho hi\n", 0o755);
    symlinkSync("README.md", join(root, "link.md"));
    symlinkSync("missing/target.txt", join(root, "broken.lnk"));
    write(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    write(join(root, ".venv", "bin", "python"), "#!/bin/sh\n", 0o755);
    write(join(root, ".env"), "API_KEY=sk-live-secret\n");
    const sessionId = "ses_v2_folder_start";
    expect(await archiver.startManifest(sessionId, root)).toBe("complete");
    expect(archiver.hasStartManifest(sessionId)).toBe(true);
    const base = await open(await archiver.captureBase(sessionId, root, 0));
    expect(base.manifest.schema).toBe("omnirush.archive.v2");
    expect(base.order.slice(0, 2)).toEqual(["__omnirush__/manifest.json", "__omnirush__/state.json"]);
    expect(base.state!.state).toEqual({ kind: "start", turn: 0 });
    expect(base.state!.start_capture).toBe("complete");
    expect(base.state!.archive_id).toBe(base.manifest.archive_id);
    expect(base.bytes("data/big.bin")!.equals(big)).toBe(true);
    expect(base.bytes("doc.pdf")!.equals(pdf)).toBe(true);
    expect(base.bytes("bun.lockb")!.equals(lockb)).toBe(true);
    expect(base.entry("run.sh")!.mode).toBe(0o755);
    expect(base.members.get("run.sh")!.mode & 0o777).toBe(0o755);
    expect([base.entry("link.md")!.target, base.entry("link.md")!.broken]).toEqual(["README.md", undefined]);
    expect([base.entry("broken.lnk")!.target, base.entry("broken.lnk")!.broken]).toEqual(["missing/target.txt", true]);
    expect(base.members.get("broken.lnk")!.linkname).toBe("missing/target.txt");
    const reasons = new Map(base.state!.excluded.map((item) => [item.path, item.reason]));
    expect([reasons.get("node_modules"), reasons.get(".venv"), reasons.get(".env")]).toEqual(["regenerable", "regenerable", "credential"]);
    expect(base.members.has(".env") || base.members.has("node_modules/dep/index.js")).toBe(false);
  });

  test("#8: the gate's cap makes a partial start; a file changed after the manifest is unstable", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-partial-");
    write(join(root, "a.txt"), "before\n");
    expect(await archiver.startManifest("ses_v2_partial_cap", root, 0)).toBe("partial");
    expect((await open(await archiver.captureBase("ses_v2_partial_cap", root, 0))).state!.start_capture).toBe("partial");
    const other = temp("omnirush-v2-unstable-");
    write(join(other, "a.txt"), "before\n");
    expect(await archiver.startManifest("ses_v2_unstable_1", other)).toBe("complete");
    write(join(other, "a.txt"), "changed before the base was packed\n");
    const base = await open(await archiver.captureBase("ses_v2_unstable_1", other, 0));
    expect(base.unstable).toEqual(["a.txt"]);
    expect(base.entry("a.txt")!.sha256).toBe(sha256("before\n"));
  });

  test("#9: pre_tool, after and final states", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-states-");
    write(join(root, "src", "app.py"), "print(1)\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    const sessionId = "ses_v2_states_1";
    await archiver.startManifest(sessionId, root);
    expect((await open(await archiver.captureBase(sessionId, root, 0))).state!.state.kind).toBe("start");
    expect(await archiver.captureState(sessionId, 1)).toEqual({ status: "skipped", reason: "unchanged" });
    write(join(root, "src", "app.py"), "print('edited between turns')\n");
    const pre = await open(await archiver.captureState(sessionId, 1));
    expect([pre.manifest.trigger, pre.manifest.turn]).toEqual(["pre_tool", 0]);
    expect(pre.state!.state).toEqual({ kind: "pre_tool", turn: 1 });
    write(join(root, "src", "new.py"), "x = 2\n");
    const after = await open(await archiver.captureDelta(sessionId, root, 1));
    expect(after.state!.state).toEqual({ kind: "after", turn: 1 });
    write(join(root, "late.txt"), "late\n");
    expect((await open(await archiver.captureFinal(sessionId, "app_quit"))).state!.state).toEqual({ kind: "final", turn: 1, reason: "app_quit" });
  });

  test("#23: .git byte for byte; the archived config without credentials, the user's untouched", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-git-");
    write(join(root, "a.txt"), "one\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "one");
    git(root, "tag", "v1");
    git(root, "remote", "add", "origin", "https://bob:ghp_SECRET123@github.com/o/r.git");
    git(root, "config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic c2VjcmV0");
    git(root, "pack-refs", "--all");
    write(join(root, "a.txt"), "stashed\n");
    git(root, "stash", "-q");
    const userConfig = readFileSync(join(root, ".git", "config"));
    const base = await open(await archiver.captureBase("ses_v2_git_bytes", root, 0));
    for (const required of [".git/HEAD", ".git/index", ".git/packed-refs", ".git/refs/stash"]) {
      expect(base.bytes(required)!.equals(readFileSync(join(root, ...required.split("/"))))).toBe(true);
    }
    const archived = base.bytes(".git/config")!.toString("utf8");
    expect(archived).not.toContain("ghp_SECRET123");
    expect(archived).not.toContain("c2VjcmV0");
    expect(base.entry(".git/config")!.scrubbed).toBe(true);
    expect(base.state!.scrubbed).toEqual([".git/config"]);
    expect(readFileSync(join(root, ".git", "config")).equals(userConfig)).toBe(true);
    const rootRepo = base.state!.repos.find((repo) => repo.position === "root")!;
    expect([rootRepo.remote, rootRepo.stash_count, rootRepo.archived]).toEqual(["https://github.com/o/r.git", 1, "byte_exact"]);
  });

  test("#23: a git config over the scrub cap is left out as too_large, never archived raw; a submodule config too", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-bigconfig-");
    write(join(root, "a.txt"), "a\n");
    git(root, "init", "-q");
    const padding = `# ${"x".repeat(120)}\n`.repeat(9_000);
    appendFileSync(join(root, ".git", "config"), `[remote "origin"]\n\turl = https://u:tok_BIGSECRET@example.com/r.git\n${padding}`);
    write(join(root, ".git", "modules", "sub", "config"), `[http]\n\textraheader = Authorization: Bearer tok_SUBSECRET\n${padding}`);
    const base = await open(await archiver.captureBase("ses_v2_big_config", root, 0));
    for (const config of [".git/config", ".git/modules/sub/config"]) {
      expect(base.entry(config)).toBeUndefined();
      expect(base.members.has(config)).toBe(false);
      const item = base.state!.excluded.find((entry) => entry.path === config) as { reason: string; size?: number } | undefined;
      expect(item?.reason).toBe("too_large");
      expect(item?.size).toBe(statSync(join(root, ...config.split("/"))).size);
    }
    for (const member of base.members.values()) {
      expect(member.content.includes("tok_BIGSECRET") || member.content.includes("tok_SUBSECRET")).toBe(false);
    }
  });

  test("#11: attachments from outside the project never copy credentials (~/.ssh, ~/.aws, .env); source paths name home as ~", async () => {
    const stateDir = temp("omnirush-v2-attach-state-");
    const home = temp("omnirush-v2-home-");
    const root = join(home, "work", "proj");
    write(join(root, "a.txt"), "a\n");
    write(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    write(join(home, ".aws", "credentials"), "[default]\naws_secret_access_key = x\n");
    write(join(home, "Downloads", ".env"), "TOKEN=x\n");
    const photo = write(join(home, "Pictures", "photo.png"), randomBytes(400));
    const store = new AttachmentStore(join(stateDir, "att"), () => false, { appDirs: [stateDir], includeCredentialFiles: false, home });
    const file = (path: string, index: number) => ({ messageId: "msg_priv", index, name: basename(path), mime: "application/octet-stream", data: null, file: path });
    const added = await store.add("ses_v2_attach_priv", root, [
      file(join(home, ".ssh", "id_ed25519"), 0),
      file(join(home, ".aws", "credentials"), 1),
      file(join(home, "Downloads", ".env"), 2),
      file(join(home, "Pictures", "photo.png"), 3),
    ]);
    expect(added.map((record) => [record.name, record.source_path])).toEqual([["photo.png", "~/Pictures/photo.png"]]);
    expect(readFileSync(added[0]!.blob).equals(photo)).toBe(true);
    expect(JSON.stringify(added.map(({ blob: _blob, ...rest }) => rest))).not.toContain(home);
    expect(homeRelativePath("/opt/data/x.bin", home)).toBe("/opt/data/x.bin");
  });

  test("#15: the repository above the folder, one in a subfolder, and one without commits", async () => {
    const { archiver, open } = rig();
    const outer = temp("omnirush-v2-outer-");
    write(join(outer, "top.txt"), "outer\n");
    git(outer, "init", "-q");
    git(outer, "add", ".");
    git(outer, "commit", "-qm", "outer");
    git(outer, "remote", "add", "origin", "https://user:ghp_secrettoken123@example.com/o/r.git");
    const root = join(outer, "packages", "app");
    write(join(root, "index.js"), "1\n");
    write(join(root, "clone", "lib.js"), "lib\n");
    git(join(root, "clone"), "init", "-q");
    git(join(root, "clone"), "add", ".");
    git(join(root, "clone"), "commit", "-qm", "clone");
    write(join(root, "fresh", "a.txt"), "staged\n");
    git(join(root, "fresh"), "init", "-q", "-b", "trunk");
    git(join(root, "fresh"), "add", "a.txt");
    const base = await open(await archiver.captureBase("ses_v2_repos_all", root, 0));
    const byPath = new Map(base.state!.repos.map((repo) => [repo.path, repo]));
    // A session in a repository's subfolder: the enclosing .git byte for byte (config scrubbed), nothing else of the repository.
    const above = byPath.get("../..")!;
    expect([above.position, above.archived, above.git_dir, above.session_subdir]).toEqual(["above", "byte_exact", "__enclosing_repo__/.git", "packages/app"]);
    expect(base.bytes("__enclosing_repo__/.git/HEAD")).toEqual(readFileSync(join(outer, ".git", "HEAD")));
    expect(base.bytes("__enclosing_repo__/.git/index")).toEqual(readFileSync(join(outer, ".git", "index")));
    const config = base.bytes("__enclosing_repo__/.git/config")!.toString("utf8");
    expect(config.includes("ghp_secrettoken123")).toBe(false);
    expect(config.includes("example.com/o/r.git")).toBe(true);
    expect(readFileSync(join(outer, ".git", "config"), "utf8").includes("ghp_secrettoken123")).toBe(true);
    expect(base.state!.scrubbed).toContain("__enclosing_repo__/.git/config");
    expect([...base.members.keys()].filter((key) => key.startsWith("__enclosing_repo__/") && !key.startsWith("__enclosing_repo__/.git"))).toEqual([]);
    expect([...base.members.keys()].some((key) => key === "top.txt" || key.startsWith("../"))).toBe(false);
    write(join(root, "index.js"), "2\n");
    git(outer, "add", "packages/app/index.js");
    git(outer, "commit", "-qm", "agent");
    const after = await open(await archiver.captureDelta("ses_v2_repos_all", root, 1));
    const branch = git(outer, "symbolic-ref", "--short", "HEAD").trim();
    expect(after.bytes(`__enclosing_repo__/.git/refs/heads/${branch}`)?.toString("utf8").trim()).toBe(git(outer, "rev-parse", "HEAD").trim());
    expect([byPath.get("clone")!.position, byPath.get("clone")!.tracked_files]).toEqual(["nested", 1]);
    const fresh = byPath.get("fresh")!;
    expect([fresh.unborn, fresh.branch, fresh.head, fresh.staged_files]).toEqual([true, "trunk", null, ["a.txt"]]);
  });

  test("#15: an inherited GIT_DIR does not empty the git block", async () => {
    const root = temp("omnirush-v2-gitenv-");
    write(join(root, "a.txt"), "a\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "a");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(temp("omnirush-v2-gitenv-other-"), "nothing.git");
    try {
      expect((await collectGitBlock(root))?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect((await discoverRepos(root, [{ path: ".git", gitfile: false }]))[0]!.error).toBeNull();
      expect(captureGitEnv(process.env).GIT_DIR).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test("#14: gitignored files the agent read or ran are archived byte for byte", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-ignored-");
    write(join(root, ".gitignore"), ".venv/\ndata/\n");
    write(join(root, "main.py"), "import csv\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    const sessionId = "ses_v2_ignored_1";
    await archiver.captureBase(sessionId, root, 0);
    const tool = write(join(root, ".venv", "bin", "pytest"), "#!/usr/bin/env python\n", 0o755);
    const dataset = write(join(root, "data", "train.csv"), "a,b\n1,2\n");
    write(join(root, ".venv", "lib", "untouched.py"), "x = 1\n");
    archiver.recordTouched(sessionId, ".venv/bin/pytest");
    archiver.recordTouched(sessionId, "data/train.csv");
    write(join(root, "main.py"), "import csv  # turn 1\n");
    const delta = await open(await archiver.captureDelta(sessionId, root, 1));
    expect(delta.bytes(".venv/bin/pytest")!.equals(tool)).toBe(true);
    expect(delta.bytes("data/train.csv")!.equals(dataset)).toBe(true);
    expect(delta.members.has(".venv/lib/untouched.py")).toBe(false);
    expect(new Map(delta.state!.excluded.map((item) => [item.path, item.reason])).get(".venv")).toBe("gitignored");
  });

  test("#11: prompt attachments under __attachments__ with their message id and source path", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-attach-");
    write(join(root, "a.txt"), "a\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "a");
    const png = randomBytes(300);
    const copied = write(join(root, "uploads", "spec.pdf"), "%PDF-1.5 attached\n");
    write(join(root, ".env"), "TOKEN=x\n");
    const sessionId = "ses_v2_attach_1";
    await archiver.captureBase(sessionId, root, 0);
    const messages = [{
      info: { id: "msg_user_1", role: "user" },
      parts: [
        { type: "file", mime: "image/png", filename: "screen.png", url: `data:image/png;base64,${png.toString("base64")}` },
        { type: "file", mime: "application/pdf", filename: "spec.pdf", url: pathToFileURL(join(root, "uploads", "spec.pdf")).href },
        { type: "file", mime: "text/plain", filename: "creds.env", url: pathToFileURL(join(root, ".env")).href },
      ],
    }];
    const added = await archiver.recordAttachments(sessionId, root, attachmentsFromMessages(messages));
    expect(added.map((record) => record.path)).toEqual(["__attachments__/msg_user_1/0-screen.png", "__attachments__/msg_user_1/1-spec.pdf"]);
    const delta = await open(await archiver.captureDelta(sessionId, root, 1));
    expect(delta.bytes("__attachments__/msg_user_1/0-screen.png")!.equals(png)).toBe(true);
    expect(delta.bytes("__attachments__/msg_user_1/1-spec.pdf")!.equals(copied)).toBe(true);
    expect(delta.state!.attachments.map((item) => [item.message_id, item.source, item.source_path, item.sha256])).toEqual([
      ["msg_user_1", "inline", null, sha256(png)],
      ["msg_user_1", "file", "uploads/spec.pdf", sha256(copied)],
    ]);
  });

  test("a v1 server: no state.json, schema v1, git configs still scrubbed", async () => {
    const { archiver, open } = rig({ all_folders: false, touched_files: true });
    const root = temp("omnirush-v2-v1-");
    write(join(root, "a.txt"), "a\n");
    git(root, "init", "-q");
    git(root, "remote", "add", "origin", "https://x:tok_v1secret@example.com/r.git");
    const base = await open(await archiver.captureBase("ses_v2_on_v1_server", root, 0));
    expect(base.manifest.schema).toBe("omnirush.archive.v1");
    expect(base.state).toBeNull();
    expect(base.bytes(".git/config")!.toString("utf8")).not.toContain("tok_v1secret");
  });

  test("#11: an @file typed in the prompt that reached the engine as text is archived (source: mention); an e-mail, a missing or a credential file is not", async () => {
    const { archiver, open } = rig();
    const root = temp("omnirush-v2-mention-");
    const logo = write(join(root, "assets", "logo.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(96)]));
    const notes = write(join(root, "my notes.md"), "# notes\n");
    write(join(root, ".env"), "TOKEN=x\n");
    git(root, "init", "-q");
    git(root, "add", "assets");
    git(root, "commit", "-qm", "a");
    const sessionId = "ses_v2_mention_1";
    await archiver.captureBase(sessionId, root, 0);
    expect(promptMentions("Look at the image @assets/logo.png. Mail me@example.com about @\"my notes.md\", @missing.txt and @.env; ping @alice"))
      .toEqual(["assets/logo.png", "my notes.md", "missing.txt", ".env"]);
    const messages = [{
      info: { id: "msg_user_m", role: "user" },
      parts: [
        { type: "text", text: "Look at the image @assets/logo.png and describe its colour, also @\"my notes.md\" and @missing.txt and @.env" },
        { type: "text", synthetic: true, text: "Called the Read tool with @ignored/synthetic.txt" },
      ],
    }, {
      info: { id: "msg_user_f", role: "user" },
      parts: [
        { type: "text", text: "and @assets/logo.png again" },
        { type: "file", mime: "image/png", filename: "logo.png", url: pathToFileURL(join(root, "assets", "logo.png")).href },
      ],
    }];
    const sources = attachmentsFromMessages(messages);
    expect(sources.filter((source) => source.messageId === "msg_user_f").length).toBe(1);
    const added = await archiver.recordAttachments(sessionId, root, sources);
    expect(added.map((record) => [record.path, record.source, record.source_path])).toEqual([
      ["__attachments__/msg_user_m/0-logo.png", "mention", "assets/logo.png"],
      ["__attachments__/msg_user_m/1-my notes.md", "mention", "my notes.md"],
      ["__attachments__/msg_user_f/0-logo.png", "file", "assets/logo.png"],
    ]);
    const delta = await open(await archiver.captureDelta(sessionId, root, 1));
    expect(delta.bytes("__attachments__/msg_user_m/0-logo.png")!.equals(logo)).toBe(true);
    expect(delta.bytes("__attachments__/msg_user_m/1-my notes.md")!.equals(notes)).toBe(true);
    const item = delta.state!.attachments.find((entry) => entry.path === "__attachments__/msg_user_m/0-logo.png")!;
    expect([item.message_id, item.source, item.sha256]).toEqual(["msg_user_m", "mention", sha256(logo)]);
  });

  test("text snapshots in a git repository: a nested repository's files are listed, and a gitignored .env counts as denied", async () => {
    const root = temp("omnirush-v2-nested-snapshot-");
    write(join(root, "README.md"), "hi\n");
    write(join(root, ".gitignore"), "build/\n.env\n");
    write(join(root, ".env"), "API_KEY=abcdef0123456789\n");
    write(join(root, "build", "gen.log"), "x\n");
    symlinkSync("README.md", join(root, "link.md"));
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    write(join(root, "vendor", "lib", "lib.js"), "lib\n");
    write(join(root, "vendor", "lib", ".gitignore"), "out/\n");
    write(join(root, "vendor", "lib", "out", "x.js"), "built\n");
    git(join(root, "vendor", "lib"), "init", "-q");
    write(join(root, "vendor", "lib", "deep", "inner", "x.txt"), "deep\n");
    git(join(root, "vendor", "lib", "deep", "inner"), "init", "-q");
    const uploads: Json[] = [];
    const sessionUploader = new SessionUploader({
      upload: async (_id: string, compressed: Uint8Array) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")));
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
    });
    sessionUploader.startSession("session-v2-nested-1", "workspace-v2", root);
    await sessionUploader.idle("session-v2-nested-1");
    await sessionUploader.stop();
    const start = uploads.find((envelope) => envelope.snapshot_type === "start")!;
    const listed = new Map((start.manifest as Array<Json>).map((entry) => [entry.path as string, entry]));
    expect(["vendor/lib/lib.js", "vendor/lib/.gitignore", "vendor/lib/deep/inner/x.txt"].every((path) => listed.has(path))).toBe(true);
    expect(listed.has("vendor/lib/out/x.js")).toBe(false);
    expect([...listed.keys()].some((key) => key.split("/").includes(".git"))).toBe(false);
    expect(listed.get("link.md")!.type).toBe("symlink");
    const excluded = start.excluded_files as { entries: Array<{ path: string; reason: string }>; counts: Record<string, number> };
    expect(excluded.entries.find((entry) => entry.path === ".env")?.reason).toBe("privacy");
    const privacy = start.privacy as Json;
    expect(privacy.denied_file_count).toBe(excluded.counts.privacy);
    expect(privacy.denied_file_count).toBe(1);
  });

  test("text snapshots: binaries with their raw digest, symlinks with their target, modes", async () => {
    const root = temp("omnirush-v2-snapshot-");
    write(join(root, "notes.md"), "# notes\n");
    write(join(root, "tool.sh"), "#!/bin/sh\n", 0o755);
    const png = write(join(root, "img.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(2_000)]));
    const asciiPdf = write(join(root, "doc.pdf"), "%PDF-1.4\nstream\nabcdefghijabcdefghijabcdefghijabcdefghij\nendstream\n%%EOF\n");
    symlinkSync("notes.md", join(root, "alias.md"));
    symlinkSync("gone.md", join(root, "dangling.md"));
    const uploads: Json[] = [];
    const binaries: string[] = [];
    const sessionUploader = new SessionUploader({
      upload: async (_id: string, compressed: Uint8Array) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")));
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
      onBinaryFile: (_id, path) => binaries.push(path),
    });
    sessionUploader.startSession("session-v2-snapshot-1", "workspace-v2", root);
    await sessionUploader.idle("session-v2-snapshot-1");
    await sessionUploader.stop();
    const start = uploads.find((envelope) => envelope.snapshot_type === "start")!;
    const manifest = start.manifest as Array<Json>;
    const listed = new Map(manifest.map((entry) => [entry.path, entry]));
    expect(listed.get("tool.sh")!.mode).toBe(0o755);
    expect(listed.get("notes.md")!.mode).toBe(statSync(join(root, "notes.md")).mode & 0o7777);
    expect([listed.get("img.png")!.binary, listed.get("img.png")!.sha256]).toEqual([true, sha256(png)]);
    expect([listed.get("doc.pdf")!.binary, listed.get("doc.pdf")!.sha256]).toEqual([true, sha256(asciiPdf)]);
    expect((start.files as Array<Json>).some((file) => file.path === "doc.pdf" || file.path === "img.png")).toBe(false);
    expect([listed.get("alias.md")!.type, listed.get("alias.md")!.target, listed.get("alias.md")!.broken]).toEqual(["symlink", "notes.md", false]);
    expect([listed.get("dangling.md")!.target, listed.get("dangling.md")!.broken]).toEqual(["gone.md", true]);
    expect(new Set(binaries)).toEqual(new Set(["img.png", "doc.pdf"]));
  });

  test("the text diff never decodes a binary section", () => {
    const text = Buffer.from("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n");
    const pdf = Buffer.concat([Buffer.from("diff --git a/x.dat b/x.dat\n--- a/x.dat\n+++ b/x.dat\n@@ -1 +1 @@\n-"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from("\n+%PDF\n")]);
    expect(utf8DiffText(Buffer.concat([text, pdf, text]))).toBe(`${text}${text}`);
    expect(filterUploadDiff(`diff --git a/doc.pdf b/doc.pdf\n--- a/doc.pdf\n+++ b/doc.pdf\n@@ -1 +1 @@\n-%PDF-1.4 a\n+%PDF-1.4 b\n${text}`).diff).not.toContain("doc.pdf");
  });

  test("lifecycle: the gate, an immediate base, one pre_tool state per turn, attachments before the turn's delta", async () => {
    const calls: Array<[string, number]> = [];
    let manifests = 0;
    const fake: ProjectArchiver = {
      captureBase: async (_id, _root, turn = 0) => (calls.push(["base", turn]), { status: "queued", archiveId: "x", kind: "base", sequence: 0, size: 1 }),
      captureDelta: async (_id, _root, turn) => (calls.push(["delta", turn ?? -1]), { status: "skipped", reason: "unchanged" }),
      captureFinal: async () => ({ status: "skipped", reason: "unchanged" }),
      startFinalCandidates: async () => [],
      recordTouched: () => undefined,
      forgetTouched: () => undefined,
      drain: async () => ({ uploaded: 0, pending: 0, dropped: 0, blocked: null, disabled: false }),
      signOut: async () => undefined,
      stop: async () => undefined,
      startManifest: async () => ((manifests += 1), "complete"),
      hasStartManifest: () => manifests > 0,
      captureState: async (_id, stateTurn) => (calls.push(["pre_tool", stateTurn]), { status: "skipped", reason: "unchanged" }),
      recordAttachments: async (_id, _root, sources) => (calls.push(["attachments", sources.length]), []),
    };
    const lifecycle = new ProjectArchiveLifecycle({ archiver: fake, enabled: true, log: () => undefined, baseIdleMs: 60_000, baseMaxDeferMs: 600_000 });
    const engine = { session: async () => ({ id: "ses_lifecycle_v2" }), messages: async () => [] };
    expect(await lifecycle.startGate("ses_lifecycle_v2", tmpdir())).toBe("complete");
    lifecycle.sessionStarted({ sessionId: "ses_lifecycle_v2", root: tmpdir(), engine });
    await lifecycle.settled();
    expect(calls).toEqual([["base", 0]]);
    lifecycle.toolStarted("ses_lifecycle_v2");
    lifecycle.toolStarted("ses_lifecycle_v2");
    await lifecycle.settled();
    expect(calls.slice(1)).toEqual([["pre_tool", 1]]);
    const turn = [{ info: { id: "msg_1", role: "user" }, parts: [{ type: "file", url: "data:text/plain;base64,eA==", filename: "x.txt" }] }, { info: { id: "msg_2", role: "assistant", time: { completed: 1 }, finish: "stop" }, parts: [] }];
    lifecycle.turnMessages("ses_lifecycle_v2", turn);
    lifecycle.turnCompleted("ses_lifecycle_v2", turn);
    await lifecycle.settled();
    expect(calls.slice(2)).toEqual([["attachments", 1], ["delta", 1]]);
    expect(await lifecycle.startGate("ses_lifecycle_v2", tmpdir())).toBe("skipped");
    await lifecycle.stop({ finals: false });
  });

  test("the tool-start hook on the engine's event stream", async () => {
    const frames = [
      { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_other", state: { status: "running" } } } },
      { type: "session.tool.called", data: { sessionID: "ses_watch", id: "call_1", name: "bash" } },
    ];
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const timer = setInterval(() => {
        if (index < frames.length) res.write(`data: ${JSON.stringify(frames[index++])}\n\n`);
      }, 20);
      req.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    let fired = 0;
    await watchToolStarts({ url: `http://127.0.0.1:${port}/api/event`, headers: new Headers(), sessionId: "ses_watch", signal: AbortSignal.timeout(5_000), fetch: (url, init) => fetch(url, init), onToolStart: () => (fired += 1) });
    server.close();
    expect(fired).toBe(1);
  });
});
