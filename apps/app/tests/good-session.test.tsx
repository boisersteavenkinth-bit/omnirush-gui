import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GOOD_SESSION_GUIDE,
  TURN_GUARD_MESSAGE,
  TURN_GUARD_QUIT,
  TURN_GUARD_WAIT,
  checklistText,
  goodSessionChecklist,
  goodSessionNudge,
  goodSessionWording,
  isCodePath,
  isHomeFolder,
  localDay,
  needsTurnGuard,
  outsideProject,
  personalService,
  ranSomething,
  shouldNudge,
  showWslBanner,
} from "../src/app/lib/good-session";
import { GoodSessionGuide } from "../src/react-app/domains/quality/good-session";

const ROOT = "/home/dev/projects/todo-api";

let seq = 0;
function tool(toolName: string, input: Record<string, unknown>, state: "output-available" | "output-error" | "input-streaming" = "output-available") {
  seq += 1;
  return state === "output-error"
    ? { type: "dynamic-tool", toolName, toolCallId: `c${seq}`, state, input, errorText: "failed" }
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

function states(messages: UIMessage[], options: { turnRunning?: boolean; nativeWindows?: boolean; root?: string } = {}) {
  const result = goodSessionChecklist({
    messages,
    workspaceRoot: options.root ?? ROOT,
    turnRunning: options.turnRunning ?? false,
    nativeWindows: options.nativeWindows ?? false,
  });
  return { result, by: Object.fromEntries(result.checks.map((check) => [check.id, check.state])) };
}

describe("code files mirror session_qc.is_code_path", () => {
  test("source, manifests and build files count; docs, lockfiles, caches and build output do not", () => {
    for (const path of ["src/app.ts", "main.py", "Dockerfile", "package.json", "requirements-dev.txt", "scripts/deploy", "src/build/x.ts", `${ROOT}/lib/db.go`]) {
      expect(isCodePath(path)).toBe(true);
    }
    for (const path of ["README.md", "notes.txt", "pnpm-lock.yaml", "Cargo.lock", "node_modules/x/index.js", "dist/app.js", ".opencode/plan.md", "/tmp/scratch.py", "bin", "logo.png", "README"]) {
      expect(isCodePath(path)).toBe(false);
    }
  });
});

describe("commands mirror session_qc.BUILD_TEST, plus running the program", () => {
  test("builds, tests and program runs count, reads do not", () => {
    for (const command of [
      "npm test", "pnpm build", "cd api && pytest -q", "python3 -m pytest tests", "go test ./...", "cargo build --release",
      "make", "npx tsc --noEmit", "tsc -p .", "node server.js", "python app.py", "./target/release/todo", "FOO=1 npm run dev",
      "bun test", "bash run.sh", "timeout 20 node index.mjs",
    ]) {
      expect(ranSomething(command)).toBe(true);
    }
    for (const command of ["ls -la", "cat package.json", "git status", "rg TODO src", "npm install", "echo hi > a.txt", "mkdir -p src"]) {
      expect(ranSomething(command)).toBe(false);
    }
  });

  test("personal services: remote programs, databases it did not build, docker, remote git", () => {
    expect(personalService("gh pr create")).toBe("gh");
    expect(personalService("ssh deploy@host 'ls'")).toBe("ssh");
    expect(personalService("docker compose up -d")).toBe("docker");
    expect(personalService("git push origin main")).toBe("a remote git repository");
    expect(personalService("psql -c 'select 1'")).toBe("psql");
    expect(personalService("psql -c 'select 1'", { dbBuilt: true })).toBeNull();
    expect(personalService("docker --version")).toBeNull();
    expect(personalService("rg 'git push' src")).toBeNull();
    expect(personalService("npm test")).toBeNull();
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
    expect(outsideProject("/home/dev/projects/todo-api-old/a.ts", ROOT)).toBe(true);
    expect(outsideProject("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe(false);
  });
});

describe("the live checklist", () => {
  test("a fresh session: nothing yet, and the running turn reads 'finish your turn'", () => {
    const messages: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "build it" }] }];
    const { result, by } = states(messages, { turnRunning: true });
    expect(by).toEqual({ code: "fail", ran: "fail", project: "pass", finished: "pending" });
    expect(result.text).toBe("Good session: code changed ✗ · ran/tested ✗ · in project ✓ · finish your turn");
    expect(result.good).toBe(false);
  });

  test("code changed, not run yet, turn still running: the spec's example line", () => {
    const { result } = states(transcript([tool("write", { filePath: `${ROOT}/src/server.ts`, content: "x" })]), { turnRunning: true });
    expect(result.text).toBe("Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn");
  });

  test("a complete session passes every check and earns the star", () => {
    const { result, by } = states(transcript(
      [tool("edit", { filePath: `${ROOT}/src/server.ts`, oldString: "a", newString: "b" })],
      [tool("bash", { command: "npm test", description: "run tests" })],
    ));
    expect(by).toEqual({ code: "pass", ran: "pass", project: "pass", finished: "pass" });
    expect(result.good).toBe(true);
    expect(result.text).toBe("Good session ★: code changed ✓ · ran/tested ✓ · in project ✓ · turn finished ✓");
    expect(goodSessionNudge(result)).toBeNull();
  });

  test("apply_patch names its files in the patch text", () => {
    const patchText = "*** Begin Patch\n*** Update File: src/app.py\n@@\n-a\n+b\n*** End Patch";
    expect(states(transcript([tool("apply_patch", { patchText })])).by.code).toBe("pass");
    expect(states(transcript([tool("apply_patch", { patchText: "*** Begin Patch\n*** Add File: docs/notes.md\n+x\n*** End Patch" })])).by.code).toBe("fail");
  });

  test("a failed edit or a docs-only change does not count as code", () => {
    expect(states(transcript([tool("edit", { filePath: "src/a.ts" }, "output-error")])).by.code).toBe("fail");
    expect(states(transcript([tool("write", { filePath: "README.md" })])).by.code).toBe("fail");
  });

  test("a failing test run still counts as running something", () => {
    expect(states(transcript([tool("bash", { command: "pytest" }, "output-error")])).by.ran).toBe("pass");
  });

  test("work outside the project, in the home folder or on a personal service fails 'in project'", () => {
    expect(states(transcript([tool("write", { filePath: "/home/dev/.bashrc", content: "x" })])).by.project).toBe("fail");
    expect(states(transcript([tool("bash", { command: "cd /home/dev/other && npm test" })])).by.project).toBe("fail");
    expect(states(transcript([tool("bash", { command: "ls", workdir: "/srv/data" })])).by.project).toBe("fail");
    expect(states(transcript([tool("bash", { command: "git push" })])).by.project).toBe("fail");
    expect(states(transcript([tool("write", { filePath: "/home/dev/a.py" })]), { root: "/home/dev" }).by.project).toBe("fail");
    // Reading outside is fine (the server restores files read in full), and so is scratch space.
    expect(states(transcript([tool("read", { filePath: "/etc/hosts" }), tool("write", { filePath: "/tmp/x.py" })])).by.project).toBe("pass");
  });

  test("the last turn: an error, a tool cut mid-call or no answer fails it", () => {
    const errored = transcript([tool("bash", { command: "npm test" })]);
    errored.push({ id: "err", role: "assistant", parts: [{ type: "text", text: "Stopped", providerMetadata: { opencode: { sessionError: { title: "Stopped" } } } }] as UIMessage["parts"] });
    expect(states(errored).by.finished).toBe("fail");
    const cut: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }, { id: "a", role: "assistant", parts: [tool("bash", { command: "npm test" }, "input-streaming")] as UIMessage["parts"] }];
    expect(states(cut).by.finished).toBe("fail");
    const unanswered: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "go" }] }];
    const { result } = states(unanswered);
    expect(result.checks.find((check) => check.id === "finished")?.label).toBe("last turn cut off");
  });

  test("native Windows adds a failing check; WSL (Linux) does not", () => {
    const messages = transcript([tool("write", { filePath: "src/a.ts" }), tool("bash", { command: "npm test" })]);
    const windows = states(messages, { nativeWindows: true });
    expect(windows.by.windows).toBe("fail");
    expect(windows.result.good).toBe(false);
    expect(windows.result.text).toContain("native Windows ✗");
    expect(states(messages).by.windows).toBeUndefined();
  });

  test("sub-agents and many turns are not required", () => {
    const { result } = states(transcript([tool("write", { filePath: "main.go" }), tool("bash", { command: "go run ." })]));
    expect(result.good).toBe(true);
  });

  test("tool names from either engine: dynamic-tool parts and typed tool-* parts", () => {
    const messages: UIMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "tool-write", toolCallId: "1", state: "output-available", input: { filePath: "src/a.rs" }, output: "ok" },
          { type: "tool-bash", toolCallId: "2", state: "output-available", input: { command: "cargo test" }, output: "ok" },
        ] as UIMessage["parts"],
      },
    ];
    expect(states(messages).result.good).toBe(true);
  });
});

describe("the nudge", () => {
  const missing = goodSessionChecklist({
    messages: transcript([tool("write", { filePath: "src/a.ts" })]),
    workspaceRoot: ROOT,
    turnRunning: false,
    nativeWindows: false,
  });

  test("once, when a turn ends with something missing", () => {
    expect(shouldNudge({ wasRunning: true, running: false, checklist: missing, alreadyNudged: false })).toBe(true);
    expect(shouldNudge({ wasRunning: true, running: false, checklist: missing, alreadyNudged: true })).toBe(false);
    expect(shouldNudge({ wasRunning: false, running: false, checklist: missing, alreadyNudged: false })).toBe(false);
    expect(shouldNudge({ wasRunning: true, running: true, checklist: missing, alreadyNudged: false })).toBe(false);
  });

  test("says what is missing, gently", () => {
    const nudge = goodSessionNudge(missing);
    expect(nudge?.title).toBe("Not a Good session ★ yet");
    expect(nudge?.body).toContain("run it or its tests");
  });
});

describe("the don't-quit-mid-turn guard", () => {
  test("asks only while a turn runs, and only when switching to another session", () => {
    expect(needsTurnGuard({ action: "quit", turnRunning: true })).toBe(true);
    expect(needsTurnGuard({ action: "close", turnRunning: true })).toBe(true);
    expect(needsTurnGuard({ action: "delete", turnRunning: true })).toBe(true);
    expect(needsTurnGuard({ action: "quit", turnRunning: false })).toBe(false);
    expect(needsTurnGuard({ action: "switch", turnRunning: true, currentSessionId: "a", targetSessionId: "b" })).toBe(true);
    expect(needsTurnGuard({ action: "switch", turnRunning: true, currentSessionId: "a", targetSessionId: "a" })).toBe(false);
    expect(needsTurnGuard({ action: "switch", turnRunning: false, currentSessionId: "a", targetSessionId: "b" })).toBe(false);
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
    expect(GOOD_SESSION_GUIDE).toEqual([
      "Work inside your project folder.",
      "Build or change real code.",
      "Run it or its tests.",
      "Let the last turn finish.",
    ]);
    const html = renderToStaticMarkup(<GoodSessionGuide />);
    expect(html).toContain("How to make a Good session");
    expect(html).toContain("On Windows? Use WSL.");
    expect(html.match(/<li>/g)?.length).toBe(4);
  });

  test("the WSL banner: native Windows only, dismissed for the day, back the next day", () => {
    const now = new Date(2026, 9, 6, 15, 0);
    expect(localDay(now)).toBe("2026-10-06");
    expect(showWslBanner({ nativeWindows: true, dismissedDay: null, now })).toBe(true);
    expect(showWslBanner({ nativeWindows: true, dismissedDay: "2026-10-06", now })).toBe(false);
    expect(showWslBanner({ nativeWindows: true, dismissedDay: "2026-10-06", now: new Date(2026, 9, 7, 9, 0) })).toBe(true);
    expect(showWslBanner({ nativeWindows: false, dismissedDay: null, now })).toBe(false);
  });

  test("checklistText marks pending checks without a tick", () => {
    expect(checklistText([
      { id: "code", state: "pass", label: "code changed", hint: "" },
      { id: "finished", state: "pending", label: "finish your turn", hint: "" },
    ])).toBe("Good session: code changed ✓ · finish your turn");
  });
});
