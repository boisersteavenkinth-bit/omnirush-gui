import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { adoptOpencodeCredentials, ENGINE2_IMPORT_MANIFEST, engine2ImportDisabled, engine2StorePath, importEngine2Sessions, v1ImportDocument } from "./import.js";
import { readEngine2Session } from "./store.js";

/**
 * The one-time import of the 2.x engine's sessions into the 1.x engine's
 * store. A 2.x store is built from the recorded 2.x conversations
 * (fixtures/v2-*.json: what the 2.x engine's API answered, the same rows its
 * `opencode.db` holds) and imported:
 *
 *   - with a stand-in engine that records each `opencode import` it is asked for;
 *   - with the bundled engine (when prepare:sidecar ran), whose 1.x API then
 *     serves the imported sessions.
 */

type Tree = { session: Record<string, any>; messages: Array<Record<string, any>>; children: Tree[] };
const fixture = (name: string): Tree => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));
const flatten = (tree: Tree, out: Tree[] = []): Tree[] => {
  out.push(tree);
  for (const child of tree.children) flatten(child, out);
  return out;
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A 2.x `opencode.db` holding `trees` (sessions placed in `directory`), as the 2.x engine's tables keep them. */
function write2xStore(path: string, trees: Tree[], directory: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL)`);
  db.run(`CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
    directory text NOT NULL, path text, title text, version text, metadata text, cost real, tokens_input integer, tokens_output integer,
    tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer, revert text, permission text, agent text, model text,
    time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer)`);
  db.run(`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`);
  for (const tree of trees) {
    for (const node of flatten(tree)) {
      const s = node.session;
      db.run(`INSERT OR IGNORE INTO project (id, worktree) VALUES (?, ?)`, [s.projectID ?? "global", "/"]);
      db.run(
        `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, path, title, version, cost, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, '', ?, '2.0.18', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.projectID ?? "global", s.parentID ?? null, s.id.slice(-8).toLowerCase(), directory, s.title ?? null, s.cost ?? 0,
          s.tokens?.input ?? 0, s.tokens?.output ?? 0, s.tokens?.reasoning ?? 0, s.tokens?.cache?.read ?? 0, s.tokens?.cache?.write ?? 0,
          s.agent ?? null, s.model ? JSON.stringify(s.model) : null, s.time.created, s.time.updated],
      );
      node.messages.forEach((message, seq) => {
        const { id, type, ...data } = message;
        db.run(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, s.id, type, seq, message.time?.created ?? 0, message.time?.created ?? 0, JSON.stringify(data)]);
      });
    }
  }
  db.close();
}

/** HOME with a 2.x store at <data>/opencode/opencode.db and a project folder. */
function makeHome(trees: Tree[]): { home: string; env: NodeJS.ProcessEnv; project: string; store: string } {
  const home = mkdtempSync(join(tmpdir(), "engine2-import-"));
  roots.push(home);
  const project = join(home, "proj");
  mkdirSync(project, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_SERVER_PASSWORD: "engine-secret",
  };
  const store = engine2StorePath(env)!;
  write2xStore(store, trees, project);
  return { home, env, project, store };
}

/** An engine stand-in: records each `import <file>` (document, folder, environment) and reports it imported. */
function fakeEngine(home: string, failFor: string[] = []): { bin: string; calls: () => Array<{ id: string; cwd: string; env: string; doc: any }> } {
  const dir = join(home, "fake-engine");
  mkdirSync(join(dir, "calls"), { recursive: true });
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh
[ "$1" = import ] || exit 2
id=$(basename "$2" .json)
for bad in ${failFor.join(" ")}; do [ "$id" = "$bad" ] && { echo "Error: decode failed" >&2; exit 1; }; done
cp "$2" "${dir}/calls/$id.json"
pwd > "${dir}/calls/$id.cwd"
env > "${dir}/calls/$id.env"
echo "Imported session: $id"
`);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => readdirSync(join(dir, "calls")).filter((name) => name.endsWith(".json")).map((name) => {
      const id = name.slice(0, -5);
      return {
        id,
        cwd: readFileSync(join(dir, "calls", `${id}.cwd`), "utf8").trim(),
        env: readFileSync(join(dir, "calls", `${id}.env`), "utf8"),
        doc: JSON.parse(readFileSync(join(dir, "calls", name), "utf8")),
      };
    }),
  };
}

describe("2.x session import (stand-in engine)", () => {
  test("every 2.x session is imported once, in its folder, as the 1.x export document", async () => {
    const trees = [fixture("v2-p1"), fixture("v2-sub")];
    const { home, env, project, store } = makeHome(trees);
    const engine = fakeEngine(home);
    const ids = trees.flatMap((tree) => flatten(tree).map((node) => node.session.id as string));

    const first = await importEngine2Sessions({ bin: engine.bin, env });
    expect(first.source).toBe(store);
    expect(first.imported.sort()).toEqual([...ids].sort());
    expect(first.failed).toEqual([]);
    const calls = engine.calls();
    expect(calls.map((call) => call.id).sort()).toEqual([...ids].sort());
    for (const call of calls) {
      expect(call.cwd).toBe(project);
      // No plugins, no project or user config, no engine password: only the stores are shared.
      expect(call.env).toContain("OPENCODE_PURE=1");
      expect(call.env).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1");
      expect(call.env).toContain(`XDG_DATA_HOME=${env.XDG_DATA_HOME}`);
      expect(call.env).not.toContain("engine-secret");
      expect(call.doc.info.id).toBe(call.id);
      expect(call.doc.info.directory).toBe(project);
      for (const message of call.doc.messages) {
        expect(message.info.sessionID).toBe(call.id);
        // The 1.x engine lists parts by id: they are numbered in their order.
        const partIds = message.parts.map((part: { id: string }) => part.id);
        expect(partIds).toEqual([...partIds].sort());
        for (const part of message.parts) expect(part.messageID).toBe(message.info.id);
      }
      // And messages by creation time, then id.
      const keys = call.doc.messages.map((message: any) => [message.info.time.created, message.info.id]);
      expect(keys).toEqual([...keys].sort((a: any, b: any) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    }
    const child = calls.find((call) => call.doc.info.parentID)!;
    expect(child.doc.info.title).toMatch(/\(@general subagent\)$/);

    const manifest = JSON.parse(readFileSync(join(env.XDG_DATA_HOME!, "omnirush", ENGINE2_IMPORT_MANIFEST), "utf8"));
    expect(Object.keys(manifest.imported).sort()).toEqual([...ids].sort());

    // The next launch finds nothing to do, and the 2.x store is untouched.
    const second = await importEngine2Sessions({ bin: engine.bin, env });
    expect(second.imported).toEqual([]);
    expect(second.done).toBe(ids.length);
    expect(engine.calls()).toHaveLength(ids.length);
    expect((await readEngine2Session(store, ids[0]!))?.messages.length).toBe(trees[0]!.messages.length);
  });

  test("a failed session is tried again on the next launches, at most three times; a missing folder waits for it", async () => {
    const trees = [fixture("v2-p1"), fixture("v2-tools")];
    const { home, env, project } = makeHome(trees);
    const bad = trees[0]!.session.id as string;
    const engine = fakeEngine(home, [bad]);
    for (let launch = 0; launch < 4; launch++) await importEngine2Sessions({ bin: engine.bin, env });
    const manifest = JSON.parse(readFileSync(join(env.XDG_DATA_HOME!, "omnirush", ENGINE2_IMPORT_MANIFEST), "utf8"));
    expect(manifest.failed[bad].attempts).toBe(3);
    expect(manifest.failed[bad].error).toContain("decode failed");
    expect(Object.keys(manifest.imported)).toEqual([trees[1]!.session.id]);

    rmSync(project, { recursive: true, force: true });
    const gone = makeHome([fixture("v2-patch")]);
    rmSync(gone.project, { recursive: true, force: true });
    const ghost = fakeEngine(gone.home);
    const skipped = await importEngine2Sessions({ bin: ghost.bin, env: gone.env });
    expect(skipped.skipped).toEqual([fixture("v2-patch").session.id]);
    mkdirSync(gone.project, { recursive: true });
    const back = await importEngine2Sessions({ bin: ghost.bin, env: gone.env });
    expect(back.imported).toEqual([fixture("v2-patch").session.id]);
  });

  test("off under test runs, with OMNIRUSH_ENGINE2_IMPORT=0 and with an explicit OPENCODE_DB", async () => {
    expect(engine2ImportDisabled({ NODE_ENV: "test" })).toBe(true);
    expect(engine2ImportDisabled({ NODE_ENV: "test", OMNIRUSH_ENGINE2_IMPORT: "1" })).toBe(false);
    expect(engine2ImportDisabled({ OMNIRUSH_ENGINE2_IMPORT: "0" })).toBe(true);
    expect(engine2ImportDisabled({ OPENCODE_DB: "/x/db" })).toBe(true);
    expect(engine2ImportDisabled({})).toBe(false);
    const { home, env } = makeHome([fixture("v2-p1")]);
    const engine = fakeEngine(home);
    expect((await importEngine2Sessions({ bin: engine.bin, env: { ...env, OMNIRUSH_ENGINE2_IMPORT: "0" } })).imported).toEqual([]);
    expect(engine.calls()).toEqual([]);
  });

  test("a store without the 2.x tables (a 1.x store) is left alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "engine2-import-v1-"));
    roots.push(home);
    const env = { HOME: home, XDG_DATA_HOME: join(home, "data") };
    mkdirSync(join(home, "data", "opencode"), { recursive: true });
    const db = new Database(join(home, "data", "opencode", "opencode.db"), { create: true });
    db.run("CREATE TABLE session (id text PRIMARY KEY)");
    db.close();
    const engine = fakeEngine(home);
    expect(await importEngine2Sessions({ bin: engine.bin, env })).toMatchObject({ imported: [], failed: [], skipped: [] });
    expect(existsSync(join(home, "data", "omnirush", ENGINE2_IMPORT_MANIFEST))).toBe(false);
  });

  test("sign-in files move over once and never replace the engine's own", () => {
    const home = mkdtempSync(join(tmpdir(), "engine2-import-auth-"));
    roots.push(home);
    const env = { HOME: home, XDG_DATA_HOME: join(home, "data") };
    mkdirSync(join(home, "data", "opencode"), { recursive: true });
    mkdirSync(join(home, "data", "omnirush"), { recursive: true });
    writeFileSync(join(home, "data", "opencode", "auth.json"), '{"openai":{"type":"api","key":"k"}}');
    writeFileSync(join(home, "data", "opencode", "mcp-auth.json"), '{"old":true}');
    writeFileSync(join(home, "data", "omnirush", "mcp-auth.json"), '{"new":true}');
    expect(adoptOpencodeCredentials(env)).toEqual(["auth.json"]);
    expect(readFileSync(join(home, "data", "omnirush", "auth.json"), "utf8")).toContain('"openai"');
    expect(readFileSync(join(home, "data", "omnirush", "mcp-auth.json"), "utf8")).toBe('{"new":true}');
    expect(adoptOpencodeCredentials(env)).toEqual([]);
  });

  test("a step that never finished is closed, its running tool an aborted error", () => {
    const tree = fixture("v2-p1");
    const step = structuredClone(tree.messages.find((message) => message.type === "assistant" && (message.content ?? []).some((entry: any) => entry.type === "tool")))!;
    delete step.time.completed;
    for (const entry of step.content) if (entry.type === "tool") entry.state = { status: "running", input: entry.state.input };
    const document = v1ImportDocument({ session: tree.session, messages: [tree.messages[0]!, step] })!;
    const reply = document.messages[1]!;
    expect(reply.info.role).toBe("assistant");
    expect((reply.info.time as { completed?: number }).completed).toBeNumber();
    const tool = reply.parts.find((part) => part.type === "tool") as { state: { status: string; error: string } };
    expect(tool.state).toMatchObject({ status: "error", error: "Tool execution aborted" });
  });
});

// ---- the bundled engine -------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../../../..");
function findSidecar(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const name = process.platform === "darwin" ? `opencode-${arch}-apple-darwin` : process.platform === "linux" ? `opencode-${arch}-unknown-linux-gnu` : "";
  const candidate = join(repoRoot, "apps/desktop/resources/sidecars", name);
  return name && existsSync(candidate) ? candidate : null;
}
const enginePath = findSidecar();
const describeEngine = enginePath ? describe : describe.skip;

describeEngine("2.x session import into the bundled engine", () => {
  let serve: ReturnType<typeof spawn> | null = null;
  let url = "";
  let setup: ReturnType<typeof makeHome>;
  const trees = [fixture("v2-p1"), fixture("v2-sub"), fixture("v2-patch"), fixture("v2-tools"), fixture("v2-nest")];

  beforeAll(async () => {
    setup = makeHome(trees);
    const result = await importEngine2Sessions({ bin: enginePath!, env: { ...process.env, ...setup.env, OMNIRUSH_ENGINE2_IMPORT: "1" } });
    expect(result.failed).toEqual([]);
    serve = spawn(enginePath!, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: setup.project,
      env: { ...process.env, ...setup.env, OPENCODE_SERVER_PASSWORD: "pw", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    url = await new Promise<string>((done, fail) => {
      let output = "";
      const timer = setTimeout(() => fail(new Error(`engine did not start: ${output}`)), 60_000);
      serve!.stdout!.on("data", (chunk) => {
        output += String(chunk);
        const match = output.match(/listening on (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          done(match[1]!);
        }
      });
    });
  }, 180_000);

  afterAll(() => {
    serve?.kill("SIGKILL");
  });

  const get = async (path: string) => {
    const target = new URL(path, url);
    target.searchParams.set("directory", setup.project);
    const response = await fetch(target, { headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };

  test("the 1.x engine lists every imported session and serves its messages in order", async () => {
    const sessions = await get("/session");
    const ids = trees.flatMap((tree) => flatten(tree).map((node) => node.session.id));
    expect(sessions.map((session: { id: string }) => session.id).sort()).toEqual([...ids].sort());
    for (const tree of trees) {
      for (const node of flatten(tree)) {
        const stored = (await readEngine2Session(setup.store, node.session.id))!;
        const expected = v1ImportDocument(stored)!;
        const served = await get(`/session/${node.session.id}/message`);
        expect(served.map((message: any) => message.info.id)).toEqual(expected.messages.map((message) => message.info.id));
        expect(served.map((message: any) => message.parts.map((part: any) => part.type)))
          .toEqual(expected.messages.map((message) => message.parts.map((part) => part.type)));
        const tools = (list: any[]) => list.flatMap((message) => message.parts).filter((part) => part.type === "tool")
          .map((part) => [part.tool, part.state.status, part.state.output ?? part.state.error]);
        expect(tools(served)).toEqual(tools(expected.messages));
      }
    }
    const child = sessions.find((session: { parentID?: string }) => session.parentID);
    expect(child.title).toMatch(/subagent\)$/);
  }, 60_000);
});
