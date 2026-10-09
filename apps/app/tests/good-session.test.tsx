import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GOOD_SESSION_GUIDE,
  GOOD_SESSION_ON_TRACK,
  TURN_GUARD_MESSAGE,
  TURN_GUARD_QUIT,
  TURN_GUARD_WAIT,
  checklistText,
  createQuitGuard,
  fetchedUrls,
  goodSessionChecklist,
  goodSessionNudge,
  goodSessionWording,
  isCodePath,
  isHomeFolder,
  leavingRunningTurn,
  localDay,
  messageFacts,
  outsideProject,
  personalService,
  ranSomething,
  shellWrites,
  shouldNudge,
  showWslBanner,
  startsServer,
  windowsNotCounted,
  writtenLines,
} from "../src/app/lib/good-session";
import { GoodSessionGuide } from "../src/react-app/domains/quality/good-session";

const ROOT = "/home/dev/projects/todo-api";
const BODY = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n");

let seq = 0;
function tool(toolName: string, input: Record<string, unknown>, state: "output-available" | "output-error" | "input-streaming" = "output-available", errorText = "failed") {
  seq += 1;
  return state === "output-error"
    ? { type: "dynamic-tool", toolName, toolCallId: `c${seq}`, state, input, errorText }
    : state === "input-streaming"
      ? { type: "dynamic-tool", toolName, toolCallId: `c${seq}`, state, input }
      : { type: "dynamic-tool", toolName, toolCallId: `c${seq}`, state, input, output: "ok" };
}

function transcript(...assistantParts: unknown[][]): UIMessage[] {
  const messages: UIMessage[] = [];
  assistantParts.forEach((parts, index) => {
    messages.push({ id: `u${index}`, role: "user", parts: [{ type: "text", text: "build the API" }] });
    messages.push({ id: `a${index}`, role: "assistant", parts: [...parts, { type: "text", text: "Done." }] as UIMessage["parts"] });
  });
  return messages;
}

function states(messages: UIMessage[], options: { turnRunning?: boolean; nativeWindows?: boolean; windowsCounts?: boolean; root?: string; serverGood?: boolean; remote?: boolean } = {}) {
  const result = goodSessionChecklist({
    ...messageFacts(messages),
    workspaceRoot: options.root ?? ROOT,
    isRemoteWorkspace: options.remote ?? false,
    turnRunning: options.turnRunning ?? false,
    // As the checklist bar passes it.
    nativeWindows: windowsNotCounted({ nativeWindows: options.nativeWindows ?? false, windowsCounts: options.windowsCounts }),
    serverGood: options.serverGood ?? false,
  });
  return { result, by: Object.fromEntries(result.checks.map((check) => [check.id, check.state])) };
}

/** Two real code files (40 lines): above WorkSize.floor's code part. */
const realWork = () => [
  tool("write", { filePath: `${ROOT}/src/server.ts`, content: BODY }),
  tool("write", { filePath: "src/routes.ts", content: BODY }),
];

describe("code files mirror session_qc.is_code_path", () => {
  test("source, manifests and build files count; docs, lockfiles, caches and build output do not", () => {
    for (const path of ["src/app.ts", "main.py", "Dockerfile", "package.json", "requirements-dev.txt", "scripts/deploy", "src/build/x.ts", `${ROOT}/lib/db.go`]) {
      expect(isCodePath(path)).toBe(true);
    }
    for (const path of ["README.md", "notes.txt", "pnpm-lock.yaml", "Cargo.lock", "node_modules/x/index.js", "dist/app.js", ".opencode/plan.md", "/tmp/scratch.py", "bin", "logo.png", "README"]) {
      expect(isCodePath(path)).toBe(false);
    }
  });

  test("written lines like session_repro._written_lines; patches count added lines", () => {
    expect(writtenLines({ content: "a\nb\nc" })).toBe(3);
    expect(writtenLines({ newString: "x" })).toBe(1);
    expect(writtenLines({ edits: [{ oldText: "a", newText: "b\nc" }, { new_text: "d" }] })).toBe(3);
    expect(writtenLines({ edits: [{ newString: "a\nb" }, { newString: "c" }] })).toBe(3);
    expect(writtenLines({ patchText: "*** Update File: a.py\n@@\n-a\n+b\n+c\n" })).toBe(2);
  });
});

describe("ran/tested is session_qc.BUILD_TEST only (WorkSize.test_runs)", () => {
  test("builds and tests count", () => {
    for (const command of [
      "npm test", "pnpm build", "cd api && pytest -q", "python3 -m pytest tests", "go test ./...", "cargo build --release",
      "make", "npx tsc --noEmit", "tsc -p .", "FOO=1 npm run build", "bun test", "timeout 20 node --test", "npx vitest run", "uv run pytest", "poetry run pytest -q",
    ]) {
      expect(ranSomething(command)).toBe(true);
    }
  });

  test("running the program, formatters and reads do not", () => {
    for (const command of [
      "ls -la", "cat package.json", "git status", "npm install", "node server.js", "python main.py", "./target/release/todo",
      "npm run dev", "npx prettier --write .", "bash run.sh", "go run .",
    ]) {
      expect(ranSomething(command)).toBe(false);
    }
  });
});

describe("outside services and machine-specific programs", () => {
  test("remote programs, databases it did not build, docker, remote git, host-only programs, the web", () => {
    expect(personalService("gh pr create")).toBe("gh");
    expect(personalService("ssh deploy@host 'ls'")).toBe("ssh");
    expect(personalService("docker compose up -d")).toBe("docker");
    expect(personalService("git push origin main")).toBe("a remote git repository");
    expect(personalService("psql -c 'select 1'")).toBe("psql");
    expect(personalService("psql -c 'select 1'", { dbBuilt: true })).toBeNull();
    expect(personalService("osascript -e 'beep'")).toContain("osascript");
    expect(personalService("open index.html")).toContain("open");
    expect(personalService("xdg-open http://localhost:3000")).toContain("xdg-open");
    expect(personalService("curl -s https://api.github.com/repos/x/y")).toContain("the web");
    expect(personalService("wget http://example.com/data.json")).toContain("the web");
    expect(personalService("curl localhost:3000/health")).toBeNull();
    expect(personalService("docker --version")).toBeNull();
    expect(personalService("rg 'git push' src")).toBeNull();
    expect(personalService("npm test")).toBeNull();
  });

  test("fetched addresses and server starts (V3 SERVER_START)", () => {
    expect(fetchedUrls("curl -sf http://127.0.0.1:8000/ && echo ok")).toEqual(["http://127.0.0.1:8000/"]);
    expect(fetchedUrls("curl localhost:3000")).toEqual(["localhost:3000"]);
    expect(startsServer("npm run dev &")).toBe(true);
    expect(startsServer("python3 -m http.server 8000")).toBe(true);
    expect(startsServer("npm test")).toBe(false);
  });

  test("shell writes: redirects, tee, cp/mv, rm", () => {
    expect(shellWrites("echo hi > ~/.bashrc")).toEqual(["~/.bashrc"]);
    expect(shellWrites("npm test 2>&1 | tee /home/dev/log.txt")).toContain("/home/dev/log.txt");
    expect(shellWrites("cp dist/app /usr/local/bin/app")).toContain("/usr/local/bin/app");
    expect(shellWrites("rm -rf /etc/x")).toContain("/etc/x");
    expect(shellWrites("npm test > /dev/null 2>&1")).toEqual(["/dev/null"]);
  });
});

describe("folders", () => {
  test("home folder and paths outside the project", () => {
    expect(isHomeFolder("/home/dev")).toBe(true);
    expect(isHomeFolder("/Users/dev/")).toBe(true);
    expect(isHomeFolder("C:\\Users\\dev")).toBe(true);
    expect(isHomeFolder(ROOT)).toBe(false);
    expect(outsideProject(`${ROOT}/src/a.ts`, ROOT)).toBe(false);
    expect(outsideProject("src/a.ts", ROOT)).toBe(false);
    expect(outsideProject("/home/dev/other/a.ts", ROOT)).toBe(true);
    expect(outsideProject("../other/a.ts", ROOT)).toBe(true);
    expect(outsideProject("/tmp/scratch", ROOT)).toBe(false);
    expect(outsideProject("/dev/null", ROOT)).toBe(false);
    expect(outsideProject("/home/dev/projects/todo-api-old/a.ts", ROOT)).toBe(true);
    expect(outsideProject("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe(false);
    expect(outsideProject("~/.bashrc", ROOT)).toBe(true);
    expect(outsideProject("~/projects/todo-api/src/a.ts", ROOT)).toBe(false);
    expect(outsideProject("$HOME/.zshrc", ROOT)).toBe(true);
    expect(outsideProject(`${ROOT}/../secret`, ROOT)).toBe(true);
    expect(outsideProject("/home/yasakei/proj/a.ts", "~/proj")).toBe(false);
    expect(outsideProject("~/proj/../other/a.ts", "/home/yasakei/proj")).toBe(true);
    expect(outsideProject("/home/yasakei/proj/../other/a.ts", "/home/yasakei/proj")).toBe(true);
    expect(outsideProject("c:/users/yasakei/appdata/local/temp/x.txt", "c:/users/yasakei/proj")).toBe(false);
  });
});

describe("the live checklist", () => {
  test("a fresh session: nothing yet, and the running turn reads 'finish your turn'", () => {
    const messages: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "build it" }] }];
    const { result, by } = states(messages, { turnRunning: true });
    expect(by).toEqual({ code: "fail", ran: "fail", project: "pass", finished: "pending" });
    expect(result.text).toBe("Good session: code changed (0 of 2 files) ✗ · ran/tested ✗ · in project ✓ · finish your turn");
    expect(result.verdict).toBe("incomplete");
  });

  test("real code changed, not tested yet, turn still running: the spec's example line", () => {
    const { result } = states(transcript(realWork()), { turnRunning: true });
    expect(result.text).toBe("Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn");
  });

  test("every local check passes: on track, with an outlined star; the filled ★ only from the server", () => {
    const messages = transcript(realWork(), [tool("bash", { command: "npm test", description: "run tests" })]);
    const { result, by } = states(messages);
    expect(by).toEqual({ code: "pass", ran: "pass", project: "pass", finished: "pass" });
    expect(result.verdict).toBe("on-track");
    expect(result.onTrack).toBe(true);
    expect(result.text).toBe(`${GOOD_SESSION_ON_TRACK}: code changed ✓ · ran/tested ✓ · in project ✓ · turn finished ✓`);
    expect(result.text.startsWith("Good session ★")).toBe(false);
    expect(goodSessionNudge(result)).toBeNull();
    const confirmed = states(messages, { serverGood: true }).result;
    expect(confirmed.verdict).toBe("good");
    expect(confirmed.text).toBe("Good session ★: code changed ✓ · ran/tested ✓ · in project ✓ · turn finished ✓");
    // The server's word never overrides a failing local check.
    expect(states(transcript(realWork()), { serverGood: true }).result.verdict).toBe("incomplete");
  });

  test("the work-size floor: 2+ code files and 30+ lines (or 5 files and 150 lines)", () => {
    const one = states(transcript([tool("write", { filePath: "src/a.ts", content: BODY }), tool("bash", { command: "npm test" })]));
    expect(one.by.code).toBe("fail");
    expect(one.result.checks[0]!.label).toBe("code changed (1 of 2 files)");
    const small = states(transcript([tool("write", { filePath: "src/a.ts", content: "a\nb" }), tool("write", { filePath: "src/b.ts", content: "c" })]));
    expect(small.result.checks[0]!.label).toBe("code changed (3 of 30 lines)");
    expect(small.result.work).toEqual({ codeFiles: 2, lines: 3, testRuns: 0 });
  });

  test("apply_patch names its files in the patch text", () => {
    const patchText = `*** Begin Patch\n*** Update File: src/app.py\n@@\n${BODY.split("\n").map((l) => `+${l}`).join("\n")}\n*** Add File: src/util.py\n+x = 1\n*** End Patch`;
    const { result } = states(transcript([tool("apply_patch", { patchText })]));
    expect(result.work.codeFiles).toBe(2);
    expect(result.work.lines).toBe(21);
    expect(states(transcript([tool("apply_patch", { patchText: "*** Begin Patch\n*** Add File: docs/notes.md\n+x\n*** End Patch" })])).result.work.codeFiles).toBe(0);
  });

  test("a failed edit or a docs-only change does not count as code", () => {
    expect(states(transcript([tool("edit", { filePath: "src/a.ts", newString: BODY }, "output-error")])).result.work.codeFiles).toBe(0);
    expect(states(transcript([tool("write", { filePath: "README.md", content: BODY })])).result.work.codeFiles).toBe(0);
  });

  test("a failing test run still counts as a run", () => {
    expect(states(transcript([tool("bash", { command: "pytest" }, "output-error")])).by.ran).toBe("pass");
  });

  test("calls the engine refused never ran: bad arguments, unknown tool, denied permission", () => {
    const messages = transcript([
      tool("write", { content: BODY }, "output-error", 'Invalid arguments for tool "write": - path: Missing key'),
      tool("bash", { command: "npm test" }, "output-error", 'No tool named "bash" is currently available.'),
      tool("bash", { command: "cd /etc && make" }, "output-error", "The user rejected permission to use this specific tool call."),
    ]);
    const { by } = states(messages);
    expect(by.code).toBe("fail");
    expect(by.ran).toBe("fail");
    expect(by.project).toBe("pass");
  });

  test("the v2 engine's shell tool and path key", () => {
    const { result } = states(transcript([
      tool("write", { path: "src/a.ts", content: BODY }), tool("write", { path: "src/b.ts", content: BODY }), tool("shell", { command: "npm test" }),
    ]));
    expect(result.verdict).toBe("on-track");
  });

  test("work outside the project, in the home folder or on an outside service fails 'in project'", () => {
    expect(states(transcript([tool("write", { filePath: "/home/dev/.bashrc", content: "x" })])).by.project).toBe("fail");
    expect(states(transcript([tool("bash", { command: "cd /home/dev/other && npm test" })])).by.project).toBe("fail");
    expect(states(transcript([tool("bash", { command: "ls", workdir: "/srv/data" })])).by.project).toBe("fail");
    expect(states(transcript([tool("bash", { command: "git push" })])).by.project).toBe("fail");
    expect(states(transcript([tool("write", { filePath: "/home/dev/a.py" })]), { root: "/home/dev" }).by.project).toBe("fail");
    expect(states(transcript([tool("websearch", { query: "express docs" })])).by.project).toBe("fail");
    expect(states(transcript([tool("browser_navigate", { url: "https://github.com" })])).by.project).toBe("fail");
    // Reading outside is fine (the server restores files read in full), and so is scratch space.
    expect(states(transcript([tool("read", { filePath: "/etc/hosts" }), tool("write", { filePath: "/tmp/x.py" })])).by.project).toBe("pass");
  });

  test("a remote workspace without a local root is not treated as missing a project", () => {
    expect(states(transcript([tool("write", { filePath: "src/a.ts", content: BODY })]), { root: "", remote: true }).by.project).toBe("pass");
  });

  test("localhost: fine once the session started the server, not before", () => {
    const started = states(transcript([tool("bash", { command: "npm run dev &" }), tool("bash", { command: "curl localhost:3000" }), tool("webfetch", { url: "http://localhost:3000" })]));
    expect(started.by.project).toBe("pass");
    const unstarted = states(transcript([tool("bash", { command: "curl -s http://localhost:3000/api" })]));
    expect(unstarted.by.project).toBe("fail");
    expect(unstarted.result.checks[2]!.hint).toContain("without starting that server");
  });

  test("the last turn: an error, a tool cut mid-call or no answer fails it", () => {
    const errored = transcript([tool("bash", { command: "npm test" })]);
    errored.push({ id: "err", role: "assistant", parts: [{ type: "text", text: "Stopped", providerMetadata: { opencode: { sessionError: { title: "Stopped" } } } }] as UIMessage["parts"] });
    expect(states(errored).by.finished).toBe("fail");
    const cut: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }, { id: "a", role: "assistant", parts: [tool("bash", { command: "npm test" }, "input-streaming")] as UIMessage["parts"] }];
    expect(states(cut).by.finished).toBe("fail");
    const unanswered: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }];
    expect(states(unanswered).result.checks.find((check) => check.id === "finished")?.label).toBe("last turn cut off");
  });

  test("native Windows adds a failing check; WSL (Linux) does not", () => {
    const messages = transcript([...realWork(), tool("bash", { command: "npm test" })]);
    const windows = states(messages, { nativeWindows: true });
    expect(windows.by.windows).toBe("fail");
    expect(windows.result.verdict).toBe("incomplete");
    expect(windows.result.text).toContain("native Windows ✗");
    expect(states(messages).by.windows).toBeUndefined();
    // An older server sends no `windows_counts`; false is the same.
    expect(states(messages, { nativeWindows: true, windowsCounts: false }).by.windows).toBe("fail");
  });

  test("while the server counts native Windows (windows_counts), there is no Windows check: on track", () => {
    const messages = transcript([...realWork(), tool("bash", { command: "npm test" })]);
    const counted = states(messages, { nativeWindows: true, windowsCounts: true });
    expect(counted.by.windows).toBeUndefined();
    expect(counted.result.verdict).toBe("on-track");
    expect(counted.result.text).toBe(`${GOOD_SESSION_ON_TRACK}: code changed ✓ · ran/tested ✓ · in project ✓ · turn finished ✓`);
    expect(counted.result.text).not.toContain("native Windows");
  });

  test("sub-agents and many turns are not required", () => {
    expect(states(transcript([...realWork(), tool("bash", { command: "go test ./..." })])).result.verdict).toBe("on-track");
  });

  test("tool names from either engine: dynamic-tool parts and typed tool-* parts", () => {
    const messages: UIMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "tool-write", toolCallId: "1", state: "output-available", input: { filePath: "src/a.rs", content: BODY }, output: "ok" },
          { type: "tool-write", toolCallId: "2", state: "output-available", input: { filePath: "src/b.rs", content: BODY }, output: "ok" },
          { type: "tool-bash", toolCallId: "3", state: "output-available", input: { command: "cargo test" }, output: "ok" },
        ] as UIMessage["parts"],
      },
    ];
    expect(states(messages).result.verdict).toBe("on-track");
  });
});

describe("the judge's eight sessions the server rejects: never a ✓ on the failing item, never the ★ label", () => {
  const one = (command: string, extra: unknown[] = []) => transcript([tool("write", { filePath: "main.py", content: BODY }), ...extra, tool("bash", { command })]);
  const cases: Array<[string, UIMessage[], "code" | "ran" | "project"]> = [
    ["1-line edit + python main.py", transcript([tool("edit", { filePath: "main.py", oldString: "a", newString: "b" }), tool("bash", { command: "python main.py" })]), "code"],
    ["write + webfetch + node --test", one("node --test", [tool("webfetch", { url: "https://docs.python.org/3/" })]), "project"],
    ["write + curl to an API + pytest", one("curl https://api.github.com/repos/a/b && pytest"), "project"],
    ["write + curl localhost (never started) + pytest", one("curl localhost:3000 && pytest"), "project"],
    ["write + npx prettier", one("npx prettier --write ."), "ran"],
    ["write + osascript; make", one("osascript -e 'display notification \"x\"'; make"), "project"],
    ["write + echo > ~/.bashrc; make", one("echo hi > ~/.bashrc; make"), "project"],
    ["write + npm install lodash && npm test", one("npm install lodash && npm test"), "code"],
  ];
  for (const [name, messages, failing] of cases) {
    test(name, () => {
      const { result, by } = states(messages);
      expect(by[failing]).toBe("fail");
      expect(result.verdict).not.toBe("good");
      expect(result.verdict).toBe("incomplete");
      expect(result.text.startsWith("Good session ★")).toBe(false);
      expect(result.text.startsWith("On track")).toBe(false);
    });
  }
});

describe("the nudge", () => {
  const missing = goodSessionChecklist({ ...messageFacts(transcript([tool("write", { filePath: "src/a.ts" })])), workspaceRoot: ROOT });

  test("once, when a turn ends with something missing", () => {
    expect(shouldNudge({ wasRunning: true, running: false, checklist: missing, alreadyNudged: false })).toBe(true);
    expect(shouldNudge({ wasRunning: true, running: false, checklist: missing, alreadyNudged: true })).toBe(false);
    expect(shouldNudge({ wasRunning: false, running: false, checklist: missing, alreadyNudged: false })).toBe(false);
    expect(shouldNudge({ wasRunning: true, running: true, checklist: missing, alreadyNudged: false })).toBe(false);
  });

  test("says what is missing, gently", () => {
    const nudge = goodSessionNudge(missing);
    expect(nudge?.title).toBe("Not a Good session ★ yet");
    expect(nudge?.body).toContain("run its tests");
  });
});

describe("the don't-leave-mid-turn guard", () => {
  test("only explicit termination actions guard a running turn", () => {
    expect(leavingRunningTurn({ action: "quit", turnRunning: true })).toBe(true);
    expect(leavingRunningTurn({ action: "close", turnRunning: true })).toBe(true);
    expect(leavingRunningTurn({ action: "delete", turnRunning: true })).toBe(true);
    expect(leavingRunningTurn({ action: "quit", turnRunning: false })).toBe(false);
  });

  test("switching between active sessions never asks to quit either session", () => {
    expect(leavingRunningTurn({ action: "switch", turnRunning: true, currentSessionId: "a", targetSessionId: "b" })).toBe(false);
    expect(leavingRunningTurn({ action: "switch", turnRunning: true, currentSessionId: "b", targetSessionId: "a" })).toBe(false);
    expect(leavingRunningTurn({ action: "switch", turnRunning: true, currentSessionId: "a", targetSessionId: "a" })).toBe(false);
  });

  test("createQuitGuard: asks once; a second request (after Wait for it) goes ahead; the turn ending re-arms", () => {
    const guard = createQuitGuard();
    expect(guard.request({ running: false })).toBe("quit");
    expect(guard.request({ running: true })).toBe("ask");
    expect(guard.answer(true)).toBe("wait");
    expect(guard.request({ running: true })).toBe("quit");
    expect(guard.turnEnded()).toBe(true);
    expect(guard.request({ running: true })).toBe("ask");
    expect(guard.answer(false)).toBe("quit");
    expect(guard.request({ running: true })).toBe("quit");
  });

  test("the dialog says the spec's words", () => {
    expect(TURN_GUARD_MESSAGE).toBe("A turn is still running. Quit now and this session won't count as a Good session ★.");
    expect([TURN_GUARD_WAIT, TURN_GUARD_QUIT]).toEqual(["Wait for it", "Quit anyway"]);
  });
});

describe("wording, the guide and the WSL banner", () => {
  test("server texts read Good session ★", () => {
    expect(goodSessionWording("Only replay-ready ★ sessions earn spins: a complete project")).toBe("Only Good sessions ★ earn spins: a complete project");
    expect(goodSessionWording("+1 spin per replay-ready ★ session")).toBe("+1 spin per Good session ★");
    expect(goodSessionWording("★ Replay-ready sessions earn +2 spins")).toBe("★ Good sessions earn +2 spins");
    expect(goodSessionWording("Replay-ready ★")).toBe("Good session ★");
    expect(goodSessionWording(null)).toBeNull();
  });

  test("the guide has the four steps and the WSL tip", () => {
    expect([...GOOD_SESSION_GUIDE]).toEqual([
      "Work inside your project folder.",
      "Build or change real code.",
      "Run it or its tests.",
      "Let the last turn finish.",
    ]);
    const html = renderToStaticMarkup(<GoodSessionGuide />);
    expect(html).toContain("How to make a Good session");
    expect(html).toContain("On Windows? Use WSL.");
    expect(html.match(/<li>/g)?.length).toBe(4);
    // While the server counts native Windows: the four steps, no WSL tip.
    const counted = renderToStaticMarkup(<GoodSessionGuide windowsCounts />);
    expect(counted).not.toContain("On Windows? Use WSL.");
    expect(counted.match(/<li>/g)?.length).toBe(4);
  });

  test("the WSL banner: native Windows only, dismissed for the day, back the next day", () => {
    const now = new Date(2026, 9, 6, 15, 0);
    expect(localDay(now)).toBe("2026-10-06");
    expect(showWslBanner({ nativeWindows: true, dismissedDay: null, now })).toBe(true);
    expect(showWslBanner({ nativeWindows: true, dismissedDay: "2026-10-06", now })).toBe(false);
    expect(showWslBanner({ nativeWindows: true, dismissedDay: "2026-10-06", now: new Date(2026, 9, 7, 9, 0) })).toBe(true);
    expect(showWslBanner({ nativeWindows: false, dismissedDay: null, now })).toBe(false);
    // None while the server counts native Windows; back when it stops.
    expect(showWslBanner({ nativeWindows: true, windowsCounts: true, dismissedDay: null, now })).toBe(false);
    expect(showWslBanner({ nativeWindows: true, windowsCounts: false, dismissedDay: null, now })).toBe(true);
  });

  test("checklistText marks pending checks without a tick", () => {
    expect(checklistText([
      { id: "code", state: "pass", label: "code changed", hint: "" },
      { id: "finished", state: "pending", label: "finish your turn", hint: "" },
    ])).toBe("Good session: code changed ✓ · finish your turn");
  });
});
