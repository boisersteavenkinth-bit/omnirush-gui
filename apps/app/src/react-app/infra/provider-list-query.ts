import { useQuery, type QueryClient } from "@tanstack/react-query";

import type { Client, ModelRef, ProviderListItem } from "../../app/types";
import { unwrap } from "../../app/lib/opencode";
import { isSupportedModelProvider } from "../../app/lib/provider-catalog";
import { dispatchNewProviders, markProvidersSeen } from "../../app/lib/provider-events";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { resolveModelDisplayName } from "../../app/utils";

export const PROVIDER_LIST_CACHE_MS = 5 * 60 * 1000;
const PROVIDER_LIST_QUERY_ROOT = ["opencode-provider-list"] as const;

export type ConnectedProviderSnapshot = Array<{
  id: string;
  name: string;
  source: ProviderListItem["source"];
  models: Record<string, ProviderListItem["models"][string]>;
}>;

export type ConnectedProviderSnapshotChange = {
  changed: boolean;
  previous: ConnectedProviderSnapshot | null;
  next: ConnectedProviderSnapshot;
};

// Bounded module-scope cache: snapshots are keyed by (baseUrl, directory) and
// would otherwise accumulate for every workspace ever opened in this app run.
// Recording refreshes a key's recency; the oldest keys are evicted past the cap.
const CONNECTED_PROVIDER_SNAPSHOT_LIMIT = 16;
const connectedProviderSnapshots = new Map<string, ConnectedProviderSnapshot>();
const connectedProviderSnapshotChanges = new Map<string, ConnectedProviderSnapshotChange>();
// Discovery history survives temporary catalog shrinkage while the current
// snapshot still reflects availability for model recovery.
const observedProviderModels = new Map<string, Map<string, Set<string>>>();

export function providerListQueryKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return [
    ...PROVIDER_LIST_QUERY_ROOT,
    input.baseUrl?.trim() ?? "",
    input.directory?.trim() ?? "",
  ] as const;
}

export async function refreshProviderListQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  await queryClient.refetchQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT, type: "active" });
}

/** Drop account-sensitive provider snapshots when the Den session ends. */
export function clearProviderListQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  connectedProviderSnapshots.clear();
  connectedProviderSnapshotChanges.clear();
  observedProviderModels.clear();
}

export async function fetchProviderList(input: {
  client: Client;
  baseUrl?: string | null;
  directory?: string | null;
}): Promise<ProviderListResponse> {
  const value = unwrap(
    await input.client.provider.list({
      directory: input.directory?.trim() || undefined,
    }),
  );
  recordConnectedProviderSnapshot(input, value);
  return value;
}

export function getConnectedProviderItems(value: ProviderListResponse | null | undefined) {
  const connected = new Set(value?.connected ?? []);
  return (value?.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
}

export function getConnectedProviderSnapshot(value: ProviderListResponse | null | undefined): ConnectedProviderSnapshot {
  return getConnectedProviderItems(value)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      models: Object.fromEntries(
        Object.entries(provider.models ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function isModelAvailableInConnectedProviders(
  value: ProviderListResponse | null | undefined,
  model: ModelRef | null | undefined,
) {
  if (!model?.providerID || !model.modelID) return true;
  return getConnectedProviderItems(value).some(
    (provider) => provider.id === model.providerID && Boolean(provider.models?.[model.modelID]),
  );
}

export function getConnectedProviderSnapshotChange(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return connectedProviderSnapshotChanges.get(connectedProviderSnapshotKey(input)) ?? null;
}

function recordConnectedProviderSnapshot(
  input: {
    baseUrl?: string | null;
    directory?: string | null;
  },
  value: ProviderListResponse,
) {
  const key = connectedProviderSnapshotKey(input);
  const previous = connectedProviderSnapshots.get(key) ?? null;
  const next = getConnectedProviderSnapshot(value);
  const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(next);
  // Delete before set so a refreshed key moves to the newest insertion slot.
  connectedProviderSnapshots.delete(key);
  connectedProviderSnapshotChanges.delete(key);
  connectedProviderSnapshots.set(key, next);
  connectedProviderSnapshotChanges.set(key, { changed, previous, next });
  while (connectedProviderSnapshots.size > CONNECTED_PROVIDER_SNAPSHOT_LIMIT) {
    const oldest = connectedProviderSnapshots.keys().next().value;
    if (oldest === undefined) break;
    connectedProviderSnapshots.delete(oldest);
    connectedProviderSnapshotChanges.delete(oldest);
    observedProviderModels.delete(oldest);
  }
  if (changed || previous === null) {
    dispatchConnectedProviderChanges(key, next);
  }
}

function connectedProviderSnapshotKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return JSON.stringify(providerListQueryKey(input));
}

function dispatchConnectedProviderChanges(
  key: string,
  snapshot: ConnectedProviderSnapshot,
) {
  // Discovery should only advertise providers that the model picker exposes.
  const next = snapshot.filter((provider) => isSupportedModelProvider(provider.id));
  const observed = observedProviderModels.get(key);
  if (!observed) {
    // Startup can briefly return an empty catalog. The first populated
    // response establishes the baseline without announcing existing models.
    if (next.length > 0) {
      observedProviderModels.set(
        key,
        new Map(next.map((provider) => [provider.id, new Set(Object.keys(provider.models))])),
      );
      // Other sync sources also use this baseline to avoid announcing a
      // returning provider that never needed an initial notification.
      markProvidersSeen(next.map((provider) => provider.id));
    }
    return;
  }

  const changedProviders: ConnectedProviderSnapshot = [];
  let newProviderCount = 0;
  let newModelCount = 0;

  for (const provider of next) {
    let modelIds = observed.get(provider.id);
    const newProvider = !modelIds;
    if (!modelIds) {
      modelIds = new Set<string>();
      observed.set(provider.id, modelIds);
      newProviderCount += 1;
    }
    const addedModelIds = Object.keys(provider.models).filter((id) => !modelIds.has(id));
    for (const id of addedModelIds) modelIds.add(id);
    newModelCount += addedModelIds.length;
    if (newProvider || addedModelIds.length > 0) changedProviders.push(provider);
  }

  if (newProviderCount === 0 && newModelCount === 0) return;

  dispatchNewProviders({
    providers: changedProviders.map((provider) => {
      const firstModelId = Object.keys(provider.models)[0];
      return {
        id: provider.id,
        name: provider.name,
        providerId: provider.id,
        firstModelId,
        firstModelName: firstModelId
          ? resolveModelDisplayName(firstModelId, provider.models[firstModelId]?.name)
          : undefined,
      };
    }),
    newProviderCount,
    newModelCount,
    source: "models_refresh",
  });
}

export function ensureProviderListQuery(
  queryClient: QueryClient,
  input: {
    client: Client;
    baseUrl?: string | null;
    directory?: string | null;
    force?: boolean;
  },
) {
  const options = {
    queryKey: providerListQueryKey(input),
    queryFn: () => fetchProviderList(input),
    gcTime: PROVIDER_LIST_CACHE_MS,
  };
  if (input.force) {
    return queryClient.fetchQuery({
      ...options,
      staleTime: 0,
    });
  }
  return queryClient.ensureQueryData({
    ...options,
    staleTime: PROVIDER_LIST_CACHE_MS,
  });
}

export function useProviderListQuery(input: {
  client: Client | null;
  baseUrl?: string | null;
  directory?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: providerListQueryKey(input),
    enabled: Boolean(input.client) && (input.enabled ?? true),
    staleTime: PROVIDER_LIST_CACHE_MS,
    gcTime: PROVIDER_LIST_CACHE_MS,
    queryFn: () => {
      if (!input.client) {
        return {
          all: [] as ProviderListItem[],
          connected: [],
          default: {},
        } satisfies ProviderListResponse;
      }
      return fetchProviderList({
        client: input.client,
        baseUrl: input.baseUrl,
        directory: input.directory,
      });
    },
  });
}
