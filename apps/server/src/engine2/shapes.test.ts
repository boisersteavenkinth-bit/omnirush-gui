import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EventTranslator } from "./events.js";
import { partId, v1Messages, v1PermissionRequest, v1QuestionRequest, v1Session, v1ToolInput, v1ToolName, v2FormAnswer, v2ToolInput, type V1Message } from "./shapes.js";

/**
 * Fixtures: the same scripted conversations run on the 1.x engine (1.18.32)
 * and on the 2.x engine (2.0.18), read back with each engine's own API
 * (`v1-*.json`: `/session/:id/message`, `v2-*.json`: `/api/session/:id/message`),
 * machine paths replaced by /work. p1: shell, write, edit and a text answer;
 * sub: two parallel sub-agents; nest: sub-agents three layers deep.
 */
type Tree = { session: Record<string, unknown>; messages: unknown[]; children: Tree[] };
const fixture = (name: string): Tree => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Every key path whose presence or value type differs between two JSON values. */
function shapeDiff(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (typeOf(a) !== typeOf(b)) {
    out.push(`${path}: ${typeOf(a)} != ${typeOf(b)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (path.endsWith(".parts")) {
      const ta = a.map((part) => (part as { type?: string }).type).join(",");
      const tb = b.map((part) => (part as { type?: string }).type).join(",");
      if (ta !== tb) out.push(`${path}: part types [${ta}] != [${tb}]`);
    }
    if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`);
    for (let index = 0; index < Math.min(a.length, b.length); index++) shapeDiff(a[index], b[index], `${path}[${index}]`, out);
    return out;
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const key of ka) if (!kb.includes(key)) out.push(`${path}.${key}: only in 1.x`);
    for (const key of kb) if (!ka.includes(key)) out.push(`${path}.${key}: only in adapter`);
    for (const key of ka) if (kb.includes(key)) shapeDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out);
  }
  return out;
}

function mapTree(tree: Tree, parentModel?: { providerID: string; modelID: string }): { messages: V1Message[]; children: Array<ReturnType<typeof mapTree>> } {
  const session = tree.session as { id: string; parentID?: string; location?: { directory?: string } };
  const messages = v1Messages(tree.messages, {
    sessionID: session.id,
    directory: session.location?.directory,
    root: "/",
    model: parentModel,
    child: Boolean(session.parentID),
  });
  return { messages, children: tree.children.map((child) => mapTree(child, parentModel)) };
}

type Mapped = ReturnType<typeof mapTree>;
/** Sub-agents start concurrently: children are paired by the task they were given. */
const taskOf = (messages: unknown[]): string => {
  const first = messages[0] as { parts?: Array<{ text?: string }> } | undefined;
  return String(first?.parts?.[0]?.text ?? "");
};

function compareTrees(v1: Tree, mapped: Mapped, path: string, out: string[]): void {
  shapeDiff(v1.messages, mapped.messages, `${path}.messages`, out);
  if (v1.children.length !== mapped.children.length) out.push(`${path}: children ${v1.children.length} != ${mapped.children.length}`);
  const left = [...v1.children].sort((a, b) => taskOf(a.messages).localeCompare(taskOf(b.messages)));
  const right = [...mapped.children].sort((a, b) => taskOf(a.messages).localeCompare(taskOf(b.messages)));
  left.forEach((child, index) => {
    if (right[index]) compareTrees(child, right[index]!, `${path}.child[${index}]`, out);
  });
}

describe("2.x messages in the 1.x shape (uploaded trace parity)", () => {
  for (const scenario of ["p1", "sub", "nest"]) {
    test(`${scenario}: every message, part and field the 1.x engine wrote, and no other`, () => {
      const out: string[] = [];
      compareTrees(fixture(`v1-${scenario}`), mapTree(fixture(`v2-${scenario}`)), "root", out);
      expect(out).toEqual([]);
    });
  }

  test("p1: the uploaded messages, field for field", () => {
    const [user, first, second, third, answer] = mapTree(fixture("v2-p1")).messages;
    expect(user!.info).toEqual({
      id: "msg_0e0eb02300010Ie6K3lQAqUici",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      role: "user",
      time: { created: 1790479893113 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "mock", modelID: "mock-model" },
    });
    expect(user!.parts).toEqual([{
      id: "prt_0e0eb02300010Ie6K3lQAqUici_u0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb02300010Ie6K3lQAqUici",
      type: "text",
      text: "PARITY-1 create the notes file",
    }]);
    expect(first!.info).toEqual({
      id: "msg_0e0eb029c001Gb432955hHZq2J",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      role: "assistant",
      time: { created: 1790479893170, completed: 1790479893443 },
      parentID: "msg_0e0eb02300010Ie6K3lQAqUici",
      modelID: "mock-model",
      providerID: "mock",
      mode: "build",
      agent: "build",
      path: { cwd: "/work/proj", root: "/" },
      cost: 0,
      tokens: { total: 1242, input: 202, output: 28, reasoning: 12, cache: { read: 1000, write: 0 } },
      finish: "tool-calls",
    });
    expect(first!.parts.map((part) => part.type)).toEqual(["step-start", "reasoning", "tool", "step-finish"]);
    expect(first!.parts[2]).toEqual({
      id: "prt_0e0eb029c001Gb432955hHZq2J_c_call_2_0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb029c001Gb432955hHZq2J",
      type: "tool",
      callID: "call_2_0",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls -a", description: "List files" },
        output: ".\n..\n",
        title: "List files",
        metadata: { output: ".\n..\n", truncated: false, exit: 0 },
        time: { start: 1790479893299, end: 1790479893435 },
      },
    });
    expect(first!.parts[3]).toEqual({
      id: "prt_0e0eb029c001Gb432955hHZq2J_f0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb029c001Gb432955hHZq2J",
      type: "step-finish",
      reason: "tool-calls",
      cost: 0,
      tokens: { total: 1242, input: 202, output: 28, reasoning: 12, cache: { read: 1000, write: 0 } },
    });
    const write = second!.parts.find((part) => part.type === "tool") as { tool: string; state: { input: unknown; metadata: unknown; title: string } };
    expect(write.tool).toBe("write");
    expect(write.state.input).toEqual({ filePath: "/work/proj/notes.md", content: "# Notes\nline one\n" });
    expect(write.state.metadata).toEqual({ diagnostics: {}, filepath: "/work/proj/notes.md", exists: false, truncated: false });
    expect(write.state.title).toBe("work/proj/notes.md");
    const edit = third!.parts.find((part) => part.type === "tool") as { tool: string; state: { input: unknown; metadata: Record<string, unknown> } };
    expect(edit.tool).toBe("edit");
    expect(edit.state.input).toEqual({ filePath: "/work/proj/notes.md", oldString: "line one", newString: "line one\nline two" });
    expect(Object.keys(edit.state.metadata)).toEqual(["diagnostics", "diff", "filediff", "truncated"]);
    expect(edit.state.metadata.filediff).toMatchObject({ file: "/work/proj/notes.md", additions: 1, deletions: 0 });
    expect(answer!.parts.map((part) => part.type)).toEqual(["step-start", "reasoning", "text", "step-finish"]);
    expect(answer!.info.finish).toBe("stop");
  });

  test("sub: task calls name their child sessions the way the 1.x engine did", () => {
    const tree = fixture("v2-sub");
    const mapped = mapTree(tree, { providerID: "mock", modelID: "mock-model" });
    const tasks = mapped.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool") as Array<{ tool: string; state: { input: Record<string, unknown>; output: string; metadata: Record<string, unknown> } }>;
    expect(tasks.map((task) => task.tool)).toEqual(["task", "task"]);
    expect(tasks[0]!.state.input).toEqual({ subagent_type: "general", description: "Read notes", prompt: "CHILD-A: read notes.md and summarise it" });
    const children = tree.children.map((child) => (child.session as { id: string }).id);
    expect(tasks.map((task) => task.state.metadata.sessionId).sort()).toEqual([...children].sort());
    expect(tasks[0]!.state.metadata).toMatchObject({ parentSessionId: (tree.session as { id: string }).id, model: { modelID: "mock-model", providerID: "mock" }, truncated: false });
    expect(tasks[0]!.state.output).toMatch(/^<task id="ses_[^"]+" state="completed">\n<task_result>\n[\s\S]+\n<\/task_result>\n<\/task>$/);
    // A child's first message is the task the parent wrote, without the 2.x preamble.
    const firstChildUser = mapped.children[0]!.messages[0]!;
    expect(firstChildUser.info.role).toBe("user");
    expect((firstChildUser.parts[0] as { text: string }).text).toMatch(/^CHILD-/);
  });

  test("sessions carry the 1.x fields (child titles name their sub-agent)", () => {
    const tree = fixture("v2-sub");
    const child = v1Session(tree.children[0]!.session, { version: "2.0.18" })!;
    expect(child.title).toMatch(/ \(@general subagent\)$/);
    expect(child.parentID).toBe((tree.session as { id: string }).id);
    expect(child.permission).toEqual([]);
    expect(Object.keys(child).sort()).toEqual(
      ["agent", "cost", "directory", "id", "parentID", "path", "permission", "projectID", "slug", "summary", "time", "title", "tokens", "version"].sort(),
    );
  });
});

describe("live events and read-back agree", () => {
  test("parts built from the 2.x stream carry the ids and fields of the same parts read back", async () => {
    const tree = fixture("v2-sub");
    const translator = new EventTranslator({ version: "2.0.18" });
    const events = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "v2-sub-events.json"), "utf8")) as unknown[];
    const live = new Map<string, Record<string, unknown>>();
    const types = new Set<string>();
    for (const event of events) {
      for (const item of await translator.translate(event)) {
        types.add(item.event.type);
        if (item.event.type === "message.part.updated") {
          const part = item.event.properties.part as Record<string, unknown>;
          live.set(String(part.id), part);
        }
      }
    }
    for (const type of ["session.created", "message.updated", "message.part.updated", "message.part.delta", "session.status", "session.idle"]) {
      expect(types.has(type)).toBe(true);
    }
    const read = mapTree(tree, { providerID: "mock", modelID: "mock-model" });
    const all = [read, ...read.children].flatMap((node) => node.messages.flatMap((message) => message.parts));
    const assistantParts = all.filter((part) => part.type !== "text" || !String(part.id).endsWith("_u0"));
    expect(assistantParts.length).toBeGreaterThan(10);
    for (const part of assistantParts) {
      const seen = live.get(String(part.id));
      expect(seen).toBeDefined();
      expect(seen!.type).toBe(part.type);
      if (part.type === "tool") {
        expect((seen!.state as { status: string }).status).toBe("completed");
        expect(seen!.tool).toBe(part.tool);
      }
    }
  });

  test("busy and idle come from the execution lifecycle", async () => {
    const translator = new EventTranslator({ version: "2.0.18" });
    const started = await translator.translate({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    expect(started.map((item) => item.event)).toEqual([{ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } }]);
    expect(translator.statuses()).toEqual({ ses_a: { type: "busy" } });
    const done = await translator.translate({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    expect(done.map((item) => item.event.type)).toEqual(["session.status", "session.idle"]);
    expect(translator.statuses()).toEqual({});
  });
});

describe("tool names, inputs, permissions and questions", () => {
  test("names and inputs map both ways", () => {
    expect(v1ToolName("shell")).toBe("bash");
    expect(v1ToolName("subagent")).toBe("task");
    expect(v1ToolName("patch")).toBe("apply_patch");
    expect(v1ToolName("webfetch")).toBe("webfetch");
    expect(v1ToolInput("read", { path: "/a", offset: 2 })).toEqual({ filePath: "/a", offset: 2 });
    expect(v1ToolInput("subagent", { agent: "general", prompt: "x", description: "d" })).toEqual({ subagent_type: "general", prompt: "x", description: "d" });
    expect(v1ToolInput("edit", '{"path":"/a","oldString":"x","newString":"y"}')).toEqual({ filePath: "/a", oldString: "x", newString: "y" });
    expect(v2ToolInput("task", { subagent_type: "general", prompt: "x" })).toEqual({ agent: "general", prompt: "x" });
    expect(v2ToolInput("write", { filePath: "/a", content: "c" })).toEqual({ path: "/a", content: "c" });
  });

  test("a 2.x permission request becomes the 1.x request", () => {
    expect(v1PermissionRequest({
      id: "per_1", sessionID: "ses_1", action: "shell", resources: ["git push"], save: ["git push *"],
      metadata: { command: "git push" }, source: { type: "tool", messageID: "msg_1", id: "call_1" },
    })).toEqual({
      id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["git push"], metadata: { command: "git push" },
      always: ["git push *"], tool: { messageID: "msg_1", callID: "call_1" },
    });
  });

  test("question forms map to 1.x questions and answers map back", () => {
    const mapping = v1QuestionRequest({
      id: "frm_1", sessionID: "ses_1",
      fields: [{ key: "color", type: "multiselect", title: "Color", description: "Pick colors", options: [{ value: "r", label: "Red", description: "" }, { value: "g", label: "Green", description: "" }] }],
    })!;
    expect(mapping.request).toEqual({
      id: "frm_1", sessionID: "ses_1",
      questions: [{ question: "Pick colors", header: "Color", options: [{ label: "Red", description: "" }, { label: "Green", description: "" }], multiple: true }],
    });
    expect(v2FormAnswer(mapping.fields, [["Green"]])).toEqual({ color: ["g"] });
  });

  test("part ids are stable per message slot", () => {
    expect(partId("msg_abc", "t0")).toBe("prt_abc_t0");
    expect(partId("msg_abc", "c", "call_9")).toBe("prt_abc_c_call_9");
  });
});
