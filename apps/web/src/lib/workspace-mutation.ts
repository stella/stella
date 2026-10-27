import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import {
  resourceMutationDigest,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

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
  const mutationDigest =
    "mutationDigest" in event ? event.mutationDigest : undefined;
  const state =
    mutationDigest === undefined
      ? undefined
      : mutations.get(client)?.get(mutationDigest);
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
  queryKeys: readonly QueryKey[];
};

/** Registers before the request: an event may arrive before its HTTP response. */
export const runWorkspaceMutation = async <T>({
  client,
  request,
  queryKeys,
}: RunWorkspaceMutationOptions<T>): Promise<T> => {
  const entries = clientMutations(client);
  const mutationId = createUuid();
  const mutationDigest = await resourceMutationDigest(mutationId);
  const pending: MutationState = { status: "pending", onFailure: [] };
  entries.set(mutationDigest, pending);
  const result = await Result.tryPromise({
    try: async () => await request(mutationId),
    catch: (cause) => cause,
  });
  const releaseEvents = () => {
    entries.delete(mutationDigest);
    for (const apply of pending.onFailure) {
      apply();
    }
  };
  if (Result.isError(result)) {
    releaseEvents();
    throw result.error;
  }
  const refresh = await Result.tryPromise({
    try: async () => {
      await Promise.all(
        queryKeys.map(async (queryKey) =>
          client.invalidateQueries({ queryKey }, { throwOnError: true }),
        ),
      );
    },
    catch: (cause) => cause,
  });
  if (Result.isError(refresh)) {
    releaseEvents();
    // The write succeeded; query error state and released echoes own recovery.
    return result.value;
  }
  entries.set(mutationDigest, { status: "acknowledged" });
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
