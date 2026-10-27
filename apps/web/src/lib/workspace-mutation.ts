import type { QueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import type { WorkspaceRealtimeEvent } from "@stll/api-contract";

import { createUuid } from "@/lib/uuid";

const MAX_ACKNOWLEDGED_MUTATIONS = 1000;
type MutationState =
  { status: "pending"; onFailure: (() => void)[] } | { status: "acknowledged" };
const mutations = new WeakMap<QueryClient, Map<string, MutationState>>();

const clientMutations = (client: QueryClient) => {
  const existing = mutations.get(client);
  if (existing) {
    return existing;
  }
  const pending = new Map<string, MutationState>();
  mutations.set(client, pending);
  return pending;
};

/** Only the initiating cache may consume the echo of its own successful write. */
export const handleWorkspaceMutationEvent = (
  client: QueryClient,
  event: WorkspaceRealtimeEvent,
  apply: () => void,
): void => {
  const mutationId = "mutationId" in event ? event.mutationId : undefined;
  const state =
    mutationId === undefined
      ? undefined
      : mutations.get(client)?.get(mutationId);
  if (!state) {
    apply();
    return;
  }
  switch (state.status) {
    case "pending":
      state.onFailure.push(apply);
      return;
    case "acknowledged":
      return;
    default:
      state satisfies never;
      return panic(`Unhandled mutation state: ${String(state)}`);
  }
};

type RunWorkspaceMutationOptions<T> = {
  client: QueryClient;
  request: (mutationId: string) => Promise<T>;
  refresh: (data: T) => Promise<void>;
};

/** Registers before the request: an event may arrive before its HTTP response. */
export const runWorkspaceMutation = async <T>({
  client,
  request,
  refresh,
}: RunWorkspaceMutationOptions<T>): Promise<T> => {
  const entries = clientMutations(client);
  const mutationId = createUuid();
  const pending: MutationState = { status: "pending", onFailure: [] };
  entries.set(mutationId, pending);
  const result = await Result.tryPromise({
    try: async () => {
      const data = await request(mutationId);
      await refresh(data);
      return data;
    },
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    entries.delete(mutationId);
    for (const apply of pending.onFailure) {
      apply();
    }
    throw result.error;
  }
  entries.set(mutationId, { status: "acknowledged" });
  let acknowledged = 0;
  for (const state of entries.values()) {
    if (state.status === "acknowledged") {
      acknowledged += 1;
    }
  }
  for (const [id, state] of entries) {
    if (acknowledged <= MAX_ACKNOWLEDGED_MUTATIONS) {
      break;
    }
    if (state.status === "acknowledged") {
      entries.delete(id);
      acknowledged -= 1;
    }
  }
  return result.value;
};
