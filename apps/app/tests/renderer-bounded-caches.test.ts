import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, ProviderListItem } from "../src/app/types";
import { createClient } from "../src/app/lib/opencode";
import { newProvidersEvent, readSeenProviderIds, type NewProvidersEventDetail } from "../src/app/lib/provider-events";
import {
  clearProviderListQueries,
  fetchProviderList,
  getConnectedProviderSnapshotChange,
} from "../src/react-app/infra/provider-list-query";
import {
  MAX_TRACKED_MESSAGE_ROLES,
  useSessionActivityStore,
} from "../src/react-app/domains/session/status/session-activity-store";

test("session activity message-role tracking stays bounded per session", () => {
  const store = useSessionActivityStore.getState();
  store.setRunStatus("ws-bounded", "session-a", "busy");
  for (let index = 0; index < MAX_TRACKED_MESSAGE_ROLES + 50; index += 1) {
    store.markMessageRole("ws-bounded", "session-a", `message-${index}`, index % 2 === 0 ? "user" : "assistant");
  }

  const record = useSessionActivityStore.getState().recordsByWorkspaceId["ws-bounded"]?.["session-a"];
  expect(record).toBeDefined();
  // The dict is capped at the most recent marks: the oldest overflowed
  // message ids are dropped, the newest are retained with their roles.
  expect(Object.keys(record?.messageRoles ?? {})).toHaveLength(MAX_TRACKED_MESSAGE_ROLES);
  expect(record?.messageRoles["message-0"]).toBeUndefined();
  expect(record?.messageRoles["message-49"]).toBeUndefined();
  expect(record?.messageRoles["message-50"]).toBe("user");
  expect(record?.messageRoles[`message-${MAX_TRACKED_MESSAGE_ROLES + 49}`]).toBe("assistant");

  // Assistant-output gating still works for a retained assistant message.
  store.markAssistantOutput("ws-bounded", "session-a", `message-${MAX_TRACKED_MESSAGE_ROLES + 49}`);
  expect(
    useSessionActivityStore.getState().recordsByWorkspaceId["ws-bounded"]?.["session-a"]?.assistantOutput,
  ).toBe(true);

  // Negative half: below the cap nothing is evicted.
  store.setRunStatus("ws-small", "session-b", "busy");
  for (let index = 0; index < 10; index += 1) {
    store.markMessageRole("ws-small", "session-b", `small-${index}`, "assistant");
  }
  const smallRecord = useSessionActivityStore.getState().recordsByWorkspaceId["ws-small"]?.["session-b"];
  expect(Object.keys(smallRecord?.messageRoles ?? {})).toHaveLength(10);
  expect(smallRecord?.messageRoles["small-0"]).toBe("assistant");
});

test("connected provider snapshot cache evicts the oldest workspace keys", async () => {
  const emptyProviderList: ProviderListResponse = { all: [], connected: [], default: {} };
  // Only provider.list is exercised by fetchProviderList; a full Client cannot
  // be constructed in a unit spec.
  const client = {
    provider: { list: async () => ({ data: emptyProviderList }) },
  } as unknown as Client;

  for (let index = 0; index < 20; index += 1) {
    await fetchProviderList({ client, baseUrl: "http://localhost:1", directory: `/tmp/workspace-${index}` });
  }

  // 20 distinct (baseUrl, directory) keys were recorded against a cap of 16:
  // the oldest keys are gone, the newest are retained.
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-0" })).toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-3" })).toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-4" })).not.toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-19" })).not.toBeNull();

  // Re-recording an existing key refreshes its recency instead of
  // double-counting it: nothing else is evicted.
  await fetchProviderList({ client, baseUrl: "http://localhost:1", directory: "/tmp/workspace-4" });
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-4" })).not.toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-5" })).not.toBeNull();
});


const originalWindow = globalThis.window;
let discoveries: NewProvidersEventDetail[] = [];

beforeEach(() => {
  clearProviderListQueries(new QueryClient());
  discoveries = [];
  const events = new EventTarget();
  const storage = new Map<string, string>();
  Object.defineProperty(events, "localStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  events.addEventListener(newProvidersEvent, (event) => {
    if (event instanceof CustomEvent) discoveries.push(event.detail);
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function providerCatalog(entries: Array<{ id: string; modelIds: string[] }>, revision = 0): ProviderListResponse {
  return {
    all: entries.map(({ id, modelIds }): ProviderListItem => ({
      id, name: id, source: "config", env: [], options: {},
      models: Object.fromEntries<ProviderListItem["models"][string]>(modelIds.map((modelId) => [modelId, {
        id: modelId, providerID: id, name: modelId + " revision " + revision,
        api: { id: modelId, url: "https://models.example", npm: "@ai-sdk/openai-compatible" },
        capabilities: {
          temperature: true, reasoning: false, attachment: false, toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: revision, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 100_000, output: 10_000 },
        status: "active", options: {}, headers: {}, release_date: "2026-01-01",
      }])),
    })),
    connected: entries.map(({ id }) => id),
    default: {},
  };
}

test("provider discovery stays quiet through startup, metadata refreshes, and reconnects", async () => {
  let response = providerCatalog([]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(response) });
  const client = createClient(server.url.toString(), "/tmp/catalog-regression");
  const input = { client, baseUrl: server.url.toString(), directory: "/tmp/catalog-regression" };
  const modelIds = Array.from({ length: 41 }, (_, index) => "model-" + index);
  const baseline = [{ id: "lpr_catalog-provider", modelIds }];
  const refresh = async (entries: Array<{ id: string; modelIds: string[] }>, revision = 0) => {
    response = providerCatalog(entries, revision);
    await fetchProviderList(input);
  };
  try {
    await refresh([]);
    await refresh(baseline);
    expect(readSeenProviderIds().has("lpr_catalog-provider")).toBe(true);
    await refresh(baseline, 1);
    expect(discoveries).toHaveLength(0);

    await refresh([]);
    const unavailable = getConnectedProviderSnapshotChange(input);
    expect(unavailable?.changed).toBe(true);
    expect(unavailable?.next).toHaveLength(0);
    await refresh(baseline, 2);
    expect(discoveries).toHaveLength(0);

    const expanded = [{ id: "lpr_catalog-provider", modelIds: [...modelIds, "new-model"] }];
    await refresh(expanded, 3);
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]).toMatchObject({ newProviderCount: 0, newModelCount: 1, source: "models_refresh" });

    await refresh(expanded, 4);
    await refresh(baseline);
    await refresh(expanded);
    expect(discoveries).toHaveLength(1);

    const newProvider = { id: "lpr_second-provider", modelIds: ["second-a", "second-b"] };
    await refresh([...expanded, newProvider]);
    expect(discoveries).toHaveLength(2);
    expect(discoveries[1]).toMatchObject({ newProviderCount: 1, newModelCount: 2 });
    await refresh(expanded);
    await refresh([...expanded, newProvider], 5);
    expect(discoveries).toHaveLength(2);

    const hiddenProvider = { id: "opencode", modelIds: Array.from({ length: 69 }, (_, index) => "hidden-model-" + index) };
    await refresh([...expanded, newProvider, hiddenProvider]);
    expect(discoveries).toHaveLength(2);

    clearProviderListQueries(new QueryClient());
    await refresh([...expanded, newProvider]);
    expect(discoveries).toHaveLength(2);
  } finally {
    server.stop(true);
  }
});
