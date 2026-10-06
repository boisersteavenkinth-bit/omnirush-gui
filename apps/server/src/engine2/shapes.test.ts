import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { partId, v1Messages, v1Session, v1ToolInput, v1ToolName, type V1Message } from "./shapes.js";

/**
 * Fixtures: the same scripted conversations run on the 1.x engine (1.18.32)
 * and on the 2.x engine (2.0.18), read back with each engine's own API
 * (`v1-*.json`: `/session/:id/message`, `v2-*.json`: `/api/session/:id/message`),
 * machine paths replaced by /work. p1: shell, write, edit and a text answer;
 * sub: two parallel sub-agents; nest: sub-agents three layers deep; patch: a GPT-style
 * apply_patch (2.x `patch`) that updates one file and adds another; tools: glob and grep.
 */
type Tree = { session: Record<string, unknown>; messages: unknown[]; children: Tree[] };
const fixture = (name: string): Tree => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Part types only the 2.x engine records; the import never writes them. */
const NATIVE_PART_TYPES = new Set(["agent-switched", "model-switched", "location-switched", "system", "idle"]);

/**
 * Every 1.x key path the converted record lacks or writes with another value
 * type ("only in 1.x" / type mismatches), and the key paths it adds ("only in
 * adapter"). Parts are paired after leaving out the 2.x-only part types (and
 * a 2.x-only part type in the converted record is reported).
 */
function shapeDiff(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (typeOf(a) !== typeOf(b)) {
    out.push(`${path}: ${typeOf(a)} != ${typeOf(b)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    let right = b;
    if (path.endsWith(".parts")) {
      const native = b.filter((part) => NATIVE_PART_TYPES.has(String((part as { type?: string }).type)));
      for (const part of native) out.push(`${path}[type=${(part as { type: string }).type}]: only in adapter`);
      right = b.filter((part) => !native.includes(part));
      const ta = a.map((part) => (part as { type?: string }).type).join(",");
      const tb = right.map((part) => (part as { type?: string }).type).join(",");
      if (ta !== tb) out.push(`${path}: part types [${ta}] != [${tb}]`);
    }
    if (a.length !== right.length) out.push(`${path}: length ${a.length} != ${right.length}`);
    for (let index = 0; index < Math.min(a.length, right.length); index++) shapeDiff(a[index], right[index], `${path}[${index}]`, out);
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

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

/** The 1.x problems of a diff: whatever is not an addition. */
const regressions = (diff: string[]) => diff.filter((line) => !line.endsWith(": only in adapter"));

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
  for (const scenario of ["p1", "sub", "nest", "patch", "tools"]) {
    test(`${scenario}: every message, part and field the 1.x engine wrote, in its place and shape`, () => {
      const out: string[] = [];
      compareTrees(fixture(`v1-${scenario}`), mapTree(fixture(`v2-${scenario}`)), "root", out);
      expect(regressions(out)).toEqual([]);
      // No record of a type the 1.x engine never wrote.
      expect(out.filter((line) => line.includes("[type="))).toEqual([]);
    });
  }

  test("p1: the uploaded messages, field for field", () => {
    const [user, first, second, third, answer] = mapTree(fixture("v2-p1")).messages;
    // 1.x fields, exactly.
    expect(pick(user!.info, ["id", "sessionID", "role", "time", "summary", "agent", "model"])).toEqual({
      id: "msg_0e0eb02300010Ie6K3lQAqUici",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      role: "user",
      time: { created: 1790479893113 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "mock", modelID: "mock-model" },
    });
    expect(user!.parts.map((part) => pick(part, ["id", "sessionID", "messageID", "type", "text"]))).toEqual([{
      id: "prt_0e0eb02300010Ie6K3lQAqUici_u0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb02300010Ie6K3lQAqUici",
      type: "text",
      text: "PARITY-1 create the notes file",
    }]);
    expect(pick(first!.info, ["id", "sessionID", "role", "time", "parentID", "modelID", "providerID", "mode", "agent", "path", "cost", "tokens", "finish"])).toEqual({
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
    expect(pick(first!.parts[2]!, ["id", "sessionID", "messageID", "type", "callID", "tool", "state"])).toEqual({
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
    expect(pick(write.state.metadata as Record<string, unknown>, ["diagnostics", "filepath", "exists", "truncated"])).toEqual({ diagnostics: {}, filepath: "/work/proj/notes.md", exists: false, truncated: false });
    expect(write.state.title).toBe("work/proj/notes.md");
    const edit = third!.parts.find((part) => part.type === "tool") as { tool: string; state: { input: unknown; metadata: Record<string, unknown> } };
    expect(edit.tool).toBe("edit");
    expect(edit.state.input).toEqual({ filePath: "/work/proj/notes.md", oldString: "line one", newString: "line one\nline two" });
    expect(Object.keys(edit.state.metadata)).toEqual(["diagnostics", "diff", "filediff", "truncated"]);
    expect(edit.state.metadata.filediff).toMatchObject({ file: "/work/proj/notes.md", additions: 1, deletions: 0 });
    // Only 1.x part types: the turn's 2.x idle marker is not written.
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

describe("prompts with synthetic notes", () => {
  const note = "Attached files were copied into this worker workspace for tool access:\n- image.png: .opencode/omnirush/inbox/chat-attachments/s/1-image.png (file:///home/u/p/.opencode/omnirush/inbox/chat-attachments/s/1-image.png)";
  const metadata = { omnirushAttachments: [] };
  const payload = {
    id: "msg_note",
    text: `${note}\n\nhi`,
    files: [{ uri: "data:image/png;base64,AAAA", name: "image.png", mime: "image/png" }],
    metadata: { omnirush: { agent: "build", textParts: [{ length: note.length, synthetic: true, metadata }, { length: 2 }] } },
  };
  const expected = [
    { id: partId("msg_note", "u0"), type: "text", text: note, synthetic: true, metadata },
    { id: partId("msg_note", "u1"), type: "text", text: "hi" },
    { id: partId("msg_note", "f0"), type: "file", filename: "image.png", url: "data:image/png;base64,AAAA" },
  ];

  test("read back: the typed prompt is its own text part, the note a synthetic part", () => {
    const [message] = v1Messages([{ type: "user", time: { created: 1 }, ...payload }], { sessionID: "ses_n", directory: "/w", root: "/" });
    expect(message!.parts).toMatchObject(expected);
    expect(message!.parts[1]!.synthetic).toBeUndefined();
    expect(message!.parts).toHaveLength(3);
  });

  test("an image the engine keeps inline reads back as its data: URL, bytes not repeated", () => {
    const inline = { data: "AAAA", mime: "image/png", source: { type: "inline" }, name: "image.png" };
    const tree = { type: "user", time: { created: 1 }, ...payload, files: [inline] };
    const [message] = v1Messages([tree], { sessionID: "ses_n", directory: "/w", root: "/" });
    expect(message!.parts).toMatchObject(expected);
    expect(JSON.stringify(message).match(/AAAA/g)).toHaveLength(1);
    // The engine's inline source is not a 1.x file source (the UI would render it as a document).
    expect(message!.parts[2]!.source).toBeUndefined();
    expect(message!.parts[2]!.data).toBeUndefined();
  });

  test("a text that no longer matches the layout stays one part", () => {
    const [message] = v1Messages([{ type: "user", time: { created: 1 }, ...payload, text: "edited" }], { sessionID: "ses_n", directory: "/w", root: "/" });
    expect(message!.parts.filter((part) => part.type === "text")).toMatchObject([{ text: "edited" }]);
    expect(message!.parts[0]!.synthetic).toBeUndefined();
  });
});

describe("tool names and inputs", () => {
  test("2.x names and inputs take their 1.x spelling", () => {
    expect(v1ToolName("shell")).toBe("bash");
    expect(v1ToolName("subagent")).toBe("task");
    expect(v1ToolName("patch")).toBe("apply_patch");
    expect(v1ToolName("webfetch")).toBe("webfetch");
    expect(v1ToolInput("read", { path: "/a", offset: 2 })).toEqual({ filePath: "/a", offset: 2 });
    expect(v1ToolInput("subagent", { agent: "general", prompt: "x", description: "d", background: true })).toEqual({ subagent_type: "general", prompt: "x", description: "d" });
    expect(v1ToolInput("edit", '{"path":"/a","oldString":"x","newString":"y"}')).toEqual({ filePath: "/a", oldString: "x", newString: "y" });
  });

  test("part ids are stable per message slot", () => {
    expect(partId("msg_abc", "t0")).toBe("prt_abc_t0");
    expect(partId("msg_abc", "c", "call_9")).toBe("prt_abc_c_call_9");
  });
});
