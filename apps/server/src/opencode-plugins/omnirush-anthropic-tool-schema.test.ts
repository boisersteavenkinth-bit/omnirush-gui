import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OmniRushAnthropicToolSchema } from "./omnirush-anthropic-tool-schema.js";

const calls: { input: Parameters<typeof fetch>[0]; init?: RequestInit }[] = [];
const fakeBase = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response("{}");
  },
  globalThis.fetch,
);

const originalFetch = globalThis.fetch;
let patchedFetch: typeof fetch;

beforeAll(async () => {
  globalThis.fetch = fakeBase;
  await OmniRushAnthropicToolSchema();
  patchedFetch = globalThis.fetch;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const ANTHROPIC_HEADERS = { "anthropic-version": "2023-06-01", "content-type": "application/json" };

// Mirrors PostHog's `file-download-batch-exports-create` MCP tool, which made
// Anthropic reject the whole request with:
// "tools.N.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level"
const topLevelAnyOf = {
  type: "object",
  anyOf: [
    {
      type: "object",
      properties: { file: { type: "object" }, name: { type: "string" } },
      required: ["file", "name"],
    },
    {
      type: "object",
      properties: { url: { type: "string" }, name: { type: "string" } },
      required: ["url", "name"],
    },
  ],
};

async function send(body: unknown, headers: Record<string, string> = ANTHROPIC_HEADERS) {
  calls.length = 0;
  await patchedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sent = calls[0]?.init?.body;
  if (typeof sent !== "string") throw new Error("expected string body");
  return JSON.parse(sent);
}

describe("OmniRushAnthropicToolSchema fetch patch", () => {
  test("flattens a top-level anyOf into a plain object schema", async () => {
    const body = await send({
      model: "claude-fable-5",
      tools: [{ name: "file-download-batch-exports-create", input_schema: topLevelAnyOf }],
    });
    const schema = body.tools[0].input_schema;
    expect(schema.anyOf).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual(["file", "name", "url"]);
    // intersection of variant required fields
    expect(schema.required).toEqual(["name"]);
    expect(schema.description).toContain("(file, name) or (url, name)");
  });

  test("flattens top-level allOf with union of required fields", async () => {
    const body = await send({
      tools: [
        {
          name: "t",
          input_schema: {
            type: "object",
            allOf: [
              { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
              { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
            ],
          },
        },
      ],
    });
    const schema = body.tools[0].input_schema;
    expect(schema.allOf).toBeUndefined();
    expect(schema.required.sort()).toEqual(["a", "b"]);
  });

  test("leaves clean schemas and nested combinators untouched", async () => {
    const clean = {
      type: "object",
      properties: { mode: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["mode"],
    };
    const body = await send({ tools: [{ name: "t", input_schema: clean }] });
    expect(body.tools[0].input_schema).toEqual(clean);
  });

  test("ignores non-anthropic requests", async () => {
    const payload = { tools: [{ name: "t", input_schema: topLevelAnyOf }] };
    const body = await send(payload, { "content-type": "application/json" });
    expect(body).toEqual(payload);
  });

  test("passes through non-JSON bodies", async () => {
    calls.length = 0;
    await patchedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: ANTHROPIC_HEADERS,
      body: "input_schema not json",
    });
    expect(calls[0]?.init?.body).toBe("input_schema not json");
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./omnirush-anthropic-tool-schema.js");
    expect(Object.keys(mod)).toEqual(["OmniRushAnthropicToolSchema"]);
  });
});

describe("tool schema transform on the 2.x engine's context hook", () => {
  const anthropicModel = { id: "claude-sonnet-5", api: { npm: "@opencode/ai/providers/anthropic" } };
  const openaiModel = { id: "gpt-6-astra", api: { npm: "@opencode/ai/providers/openai" } };

  async function transform(model: unknown, tools: Record<string, { description: string; input: Record<string, unknown> }>) {
    const hooks = (await OmniRushAnthropicToolSchema()) as unknown as Record<string, (input: unknown, output: unknown) => Promise<void>>;
    await hooks["omnirush.tools.transform"]!({ model }, { tools });
    return tools;
  }

  test("flattens a top-level anyOf for an Anthropic model, in place", async () => {
    const tools = await transform(anthropicModel, {
      export_batch: { description: "Export", input: structuredClone(topLevelAnyOf) },
      plain: { description: "Plain", input: { type: "object", properties: { a: { type: "string" } } } },
    });
    expect(tools.export_batch!.input.anyOf).toBeUndefined();
    expect(tools.export_batch!.input.type).toBe("object");
    expect(Object.keys(tools.export_batch!.input.properties as object).sort()).toEqual(["file", "name", "url"]);
    expect(tools.plain!.input).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  test("flattens oneOf and allOf, and Messages-protocol and Claude models too", async () => {
    for (const model of [{ id: "x", api: { npm: "@opencode/ai/providers/google-vertex/messages" } }, { id: "claude-4", api: { npm: "@opencode/ai/providers/amazon-bedrock" } }]) {
      const tools = await transform(model, {
        one: { description: "", input: { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "number" } }, required: ["b"] }] } },
        all: { description: "", input: { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "number" } }, required: ["b"] }] } },
      });
      expect(tools.one!.input.oneOf).toBeUndefined();
      expect(tools.all!.input.allOf).toBeUndefined();
      expect(tools.all!.input.required).toEqual(["a", "b"]);
    }
  });

  test("leaves other providers' schemas unchanged", async () => {
    const input = structuredClone(topLevelAnyOf);
    const tools = await transform(openaiModel, { export_batch: { description: "Export", input } });
    expect(tools.export_batch!.input).toEqual(topLevelAnyOf);
  });
});
