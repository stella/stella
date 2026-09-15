import { QueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  createdDocxSuggestionRows,
  DOCX_SUGGESTION_CACHE_WRITE,
  revertedDocxSuggestionRow,
  writeDocxSuggestionsCache,
} from "@/components/ai-suggestions/docx-suggestion-cache";
import {
  serializeSuggestionWrite,
  settleReviewSessionWrites,
  trackReviewSessionWrite,
} from "@/components/ai-suggestions/review-session-writes";
import { useReviewStore } from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { toSafeId } from "@/lib/safe-id";
import { docxSuggestionsOptions } from "@/lib/workspaces/queries/docx-suggestions";

const WORKSPACE_ID = "workspace-1";
const ENTITY_ID = "entity-1";
const CREATED_AT = new Date("2026-09-15T10:00:00.000Z");

const suggestion = (id: string): ReviewSuggestion => ({
  id,
  origin: "chat",
  blockId: "block-1",
  type: "replaceInBlock",
  summary: id,
  preview: {
    type: "replaceInBlock",
    contextBefore: "",
    before: "before",
    after: "after",
    contextAfter: "",
  },
  severity: "medium",
  area: "Body",
  status: "pending",
  applyMode: null,
  revisionIds: null,
  proposalBatchId: "proposal-1",
  undoHandle: null,
  pendingOperation: {
    id,
    type: "replaceInBlock",
    blockId: "block-1",
    find: "before",
    replace: "after",
  },
  snapshot: null,
  persisted: true,
});

const row = (id: string) =>
  createdDocxSuggestionRows({
    suggestions: [suggestion(id)],
    created: [{ ref: id, id: toSafeId<"docxSuggestion">(id) }],
    createdAt: CREATED_AT,
  }).at(0) ?? panic("A suggestion with an operation always has a pending row");

const listQueryKey = () =>
  docxSuggestionsOptions({ workspaceId: WORKSPACE_ID, entityId: ENTITY_ID })
    .queryKey;

const target = (queryClient: QueryClient) => ({
  queryClient,
  workspaceId: WORKSPACE_ID,
  entityId: ENTITY_ID,
});

const seedCache = (queryClient: QueryClient, ids: readonly string[]) => {
  queryClient.setQueryData(listQueryKey(), { items: ids.map(row) });
};

// Mirrors useSyncDocxSuggestions: every cached row merges into the session.
const hydrateFromCache = (queryClient: QueryClient) => {
  const data = queryClient.getQueryData(listQueryKey());
  useReviewStore.getState().hydrateSuggestions(
    ENTITY_ID,
    (data?.items ?? []).map((cached) =>
      Object.assign(suggestion(cached.id), { status: cached.status }),
    ),
  );
};

const sessionIds = () =>
  (useReviewStore.getState().sessions[ENTITY_ID] ?? []).map((item) => item.id);

// A list fetch that started before a write and still carries the rows as
// they were then. Resolving it lands those rows unless the write cancelled it.
const startStaleListFetch = (
  queryClient: QueryClient,
  ids: readonly string[],
) => {
  const response = Promise.withResolvers<undefined>();
  const loadRowsAsTheyWere = async () => {
    await response.promise;
    return { items: ids.map(row) };
  };
  const fetched = Result.tryPromise({
    try: async () =>
      await queryClient.query({
        queryKey: listQueryKey(),
        queryFn: loadRowsAsTheyWere,
      }),
    catch: (cause) => cause,
  });
  return {
    land: async () => {
      response.resolve(undefined);
      await fetched;
    },
  };
};

beforeEach(() => {
  useReviewStore.getState().resetSession(ENTITY_ID);
});

describe("docx suggestion hydration cache", () => {
  test("rows resolved or dismissed do not return after a session reset", async () => {
    const queryClient = new QueryClient();
    seedCache(queryClient, ["s1", "s2", "s3", "s4"]);
    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual(["s1", "s2", "s3", "s4"]);

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
        suggestionIds: ["s1"],
      },
    });
    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
        suggestionIds: ["s2", "s3"],
      },
    });

    useReviewStore.getState().resetSession(ENTITY_ID);
    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual(["s4"]);
  });

  test("a reverted or created row enters the pending list once", async () => {
    const queryClient = new QueryClient();
    seedCache(queryClient, ["s1"]);
    const enter = {
      type: DOCX_SUGGESTION_CACHE_WRITE.enterPending,
      rows: [row("s1"), row("s2")],
    };

    await writeDocxSuggestionsCache({ ...target(queryClient), write: enter });
    await writeDocxSuggestionsCache({ ...target(queryClient), write: enter });

    useReviewStore.getState().resetSession(ENTITY_ID);
    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual(["s1", "s2"]);
  });

  test("rows entering the pending list land in the server's order", async () => {
    const queryClient = new QueryClient();
    const earlier = new Date("2026-09-15T09:00:00.000Z");
    const later = new Date("2026-09-15T12:00:00.000Z");
    const rowAt = (id: string, createdAt: Date) =>
      createdDocxSuggestionRows({
        suggestions: [suggestion(id)],
        created: [{ ref: id, id: toSafeId<"docxSuggestion">(id) }],
        createdAt,
      }).at(0) ?? panic("A suggestion with an operation always has a row");
    queryClient.setQueryData(listQueryKey(), { items: [rowAt("s3", later)] });

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.enterPending,
        rows: [rowAt("s2", earlier), rowAt("s1", earlier)],
      },
    });

    expect(
      queryClient.getQueryData(listQueryKey())?.items.map((item) => item.id),
    ).toEqual(["s1", "s2", "s3"].map((id) => toSafeId<"docxSuggestion">(id)));
  });

  test("a created batch shares the server createdAt, and a revert keeps it", async () => {
    const queryClient = new QueryClient();
    seedCache(queryClient, []);
    const batchCreatedAt = new Date("2026-09-15T11:30:00.123Z");
    const queued = ["client-1", "client-2"].map((id) =>
      Object.assign(suggestion(id), { persisted: false }),
    );
    useReviewStore.getState().appendSuggestions(ENTITY_ID, queued);

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.enterPending,
        rows: createdDocxSuggestionRows({
          suggestions: queued,
          created: [
            { ref: "client-1", id: toSafeId<"docxSuggestion">("server-1") },
            { ref: "client-2", id: toSafeId<"docxSuggestion">("server-2") },
          ],
          createdAt: batchCreatedAt,
        }),
      },
    });
    useReviewStore.getState().reconcileServerIds(ENTITY_ID, {
      refToId: { "client-1": "server-1", "client-2": "server-2" },
      createdAt: batchCreatedAt,
    });

    // server-1 is resolved (it leaves the pending list), then reverted.
    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
        suggestionIds: ["server-1"],
      },
    });
    const resolved =
      useReviewStore
        .getState()
        .sessions[ENTITY_ID]?.find((item) => item.id === "server-1") ??
      panic("The reconciled row stays in the session");
    const reverted =
      revertedDocxSuggestionRow(resolved) ??
      panic("A persisted row always has a reverted row");
    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.enterPending,
        rows: [reverted],
      },
    });

    const cached = queryClient.getQueryData(listQueryKey())?.items ?? [];
    expect(cached.map((item) => item.id).toSorted()).toEqual([
      toSafeId<"docxSuggestion">("server-1"),
      toSafeId<"docxSuggestion">("server-2"),
    ]);
    expect(cached.map((item) => item.createdAt)).toEqual([
      batchCreatedAt,
      batchCreatedAt,
    ]);
  });

  test("a write before the list has loaded leaves nothing to hydrate", async () => {
    const queryClient = new QueryClient();

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.enterPending,
        rows: [row("s1")],
      },
    });

    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual([]);
  });

  test("a list fetch started before a write does not restore the rows it removed", async () => {
    const queryClient = new QueryClient();
    seedCache(queryClient, ["s1", "s2"]);
    const staleFetch = startStaleListFetch(queryClient, ["s1", "s2"]);

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
        suggestionIds: ["s1"],
      },
    });
    await staleFetch.land();

    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual(["s2"]);
  });

  test("an initial list fetch in flight during a write never lands its rows", async () => {
    const queryClient = new QueryClient();
    const staleFetch = startStaleListFetch(queryClient, ["s1"]);

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
        suggestionIds: ["s1"],
      },
    });
    await staleFetch.land();

    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual([]);
  });
});

type PersistBatchOptions = {
  queryClient: QueryClient;
  ids: readonly string[];
  created: Promise<undefined>;
};

// Mirrors persistQueuedSuggestions: the create lands, server ids reconcile
// into the session, and rows the reviewer already resolved are replayed. The
// replay only runs while the session still exists.
const persistBatch = async ({
  queryClient,
  ids,
  created,
}: PersistBatchOptions) => {
  await created;
  await writeDocxSuggestionsCache({
    ...target(queryClient),
    write: {
      type: DOCX_SUGGESTION_CACHE_WRITE.enterPending,
      rows: ids.map(row),
    },
  });
  useReviewStore.getState().reconcileServerIds(ENTITY_ID, {
    refToId: Object.fromEntries(ids.map((id) => [id, id])),
    createdAt: CREATED_AT,
  });
  const session = useReviewStore.getState().sessions[ENTITY_ID];
  if (session === undefined) {
    return;
  }
  await writeDocxSuggestionsCache({
    ...target(queryClient),
    write: {
      type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
      suggestionIds: session.flatMap((item) =>
        ids.includes(item.id) &&
        (item.status === "accepted" || item.status === "rejected")
          ? [item.id]
          : [],
      ),
    },
  });
};

const queueUnpersisted = (
  ids: readonly string[],
  status: ReviewSuggestion["status"],
) => {
  useReviewStore.getState().appendSuggestions(
    ENTITY_ID,
    ids.map((id) =>
      Object.assign(suggestion(id), { status, persisted: false }),
    ),
  );
};

type InFlightCreate = {
  queryClient: QueryClient;
  resolveCreate: () => void;
  persist: Promise<void>;
};

const startInFlightCreate = (ids: readonly string[]): InFlightCreate => {
  const queryClient = new QueryClient();
  seedCache(queryClient, []);
  const create = Promise.withResolvers<undefined>();
  const persist = trackReviewSessionWrite(
    ENTITY_ID,
    persistBatch({ queryClient, ids, created: create.promise }),
  );
  return {
    queryClient,
    resolveCreate: () => {
      create.resolve(undefined);
    },
    persist,
  };
};

describe("a session reset racing an in-flight create", () => {
  test("without waiting, rows resolved before the create lands come back", async () => {
    queueUnpersisted(["s1", "s2"], "rejected");
    const { queryClient, resolveCreate, persist } = startInFlightCreate([
      "s1",
      "s2",
    ]);

    useReviewStore.getState().resetSession(ENTITY_ID);
    resolveCreate();
    await persist;

    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual(["s1", "s2"]);
  });

  test("a reset after settling re-hydrates no resolved rows", async () => {
    queueUnpersisted(["s1", "s2"], "rejected");
    const { queryClient, resolveCreate, persist } = startInFlightCreate([
      "s1",
      "s2",
    ]);

    const settled = settleReviewSessionWrites(ENTITY_ID);
    // The create lands on a later task, after anything that does not wait.
    setTimeout(resolveCreate, 0);
    await settled;
    useReviewStore.getState().resetSession(ENTITY_ID);
    await persist;

    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual([]);
  });

  test("dismiss rejects rows whose create landed while it waited", async () => {
    queueUnpersisted(["s1"], "pending");
    const { queryClient, resolveCreate } = startInFlightCreate(["s1"]);

    const settled = settleReviewSessionWrites(ENTITY_ID);
    // The create lands on a later task, after anything that does not wait.
    setTimeout(resolveCreate, 0);
    await settled;
    const persistedIds = (
      useReviewStore.getState().sessions[ENTITY_ID] ?? []
    ).flatMap((item) =>
      item.status === "pending" && item.persisted === true ? [item.id] : [],
    );
    expect(persistedIds).toEqual(["s1"]);

    await writeDocxSuggestionsCache({
      ...target(queryClient),
      write: {
        type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
        suggestionIds: persistedIds,
      },
    });
    useReviewStore.getState().resetSession(ENTITY_ID);

    hydrateFromCache(queryClient);
    expect(sessionIds()).toEqual([]);
  });
});

describe("review writes a session reset waits for", () => {
  test("dismiss reads a row an in-flight accept rolled back to pending", async () => {
    const queryClient = new QueryClient();
    seedCache(queryClient, ["s1"]);
    hydrateFromCache(queryClient);
    useReviewStore.getState().setStatusBatch(ENTITY_ID, ["s1"], "applying");
    const response = Promise.withResolvers<undefined>();
    // The server did not take the accept, so the accept rolls its row back.
    const accept = trackReviewSessionWrite(
      ENTITY_ID,
      (async () => {
        await response.promise;
        useReviewStore
          .getState()
          .updateSuggestion(ENTITY_ID, "s1", { status: "pending" });
      })(),
    );

    const settled = settleReviewSessionWrites(ENTITY_ID);
    // The accept's response lands on a later task.
    setTimeout(() => {
      response.resolve(undefined);
    }, 0);
    await settled;

    const pendingIds = (
      useReviewStore.getState().sessions[ENTITY_ID] ?? []
    ).flatMap((item) => (item.status === "pending" ? [item.id] : []));
    expect(pendingIds).toEqual(["s1"]);
    await accept;
  });

  test("a suggestion's writes reach the server in submission order", async () => {
    const order: string[] = [];
    const acceptResponse = Promise.withResolvers<undefined>();
    const accept = serializeSuggestionWrite({
      reviewSessionId: ENTITY_ID,
      suggestionId: "s1",
      write: async () => {
        await acceptResponse.promise;
        order.push("accept");
      },
    });
    const revert = serializeSuggestionWrite({
      reviewSessionId: ENTITY_ID,
      suggestionId: "s1",
      write: async () => {
        order.push("revert");
      },
    });

    acceptResponse.resolve(undefined);
    await Promise.all([accept, revert]);
    expect(order).toEqual(["accept", "revert"]);
  });
});
