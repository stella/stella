import { QueryClient } from "@tanstack/react-query";
import { beforeAll, describe, expect, test } from "bun:test";

import type { ViewLayout, WorkspaceView } from "@/lib/types";

// `viewsKeys` pulls in the Eden client, which reads the API URL at import time.
beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const WORKSPACE_ID = "ws_reorder";

const TABLE_LAYOUT = {
  version: 1,
  type: "table",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  columnOrder: [],
  columnPinning: [],
} as const satisfies ViewLayout;

const view = (id: string, position: number) =>
  ({
    version: 1,
    id,
    name: id,
    layout: TABLE_LAYOUT,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) satisfies WorkspaceView;

const CACHED_VIEWS = ["overview", "table", "files", "kanban"].map(view);
const CACHED_IDS = CACHED_VIEWS.map((cached) => cached.id);

const seededClient = async () => {
  const { viewsKeys } = await import("@/lib/workspaces/queries/views");
  const queryClient = new QueryClient();
  queryClient.setQueryData(viewsKeys.localized(WORKSPACE_ID), CACHED_VIEWS);
  return queryClient;
};

const cachedOrder = async (queryClient: QueryClient) => {
  const { viewsKeys } = await import("@/lib/workspaces/queries/views");
  return queryClient
    .getQueryData<WorkspaceView[]>(viewsKeys.localized(WORKSPACE_ID))
    ?.map((cached) => cached.id);
};

describe("optimistic view order", () => {
  test("applies every landing position a drag can produce", async () => {
    const { reorderCachedViews } = await import("./views.logic");

    // A drag lifts one view and reinserts it, so this is the full set of orders
    // `reorderViewIds` can hand the mutation.
    for (const draggedId of CACHED_IDS) {
      const without = CACHED_IDS.filter((id) => id !== draggedId);

      for (let landing = 0; landing <= without.length; landing++) {
        const viewIds = without.toSpliced(landing, 0, draggedId);
        const reordered = reorderCachedViews(CACHED_VIEWS, viewIds);

        expect(reordered?.map((cached) => cached.id)).toEqual(viewIds);
      }
    }
  });

  test("leaves the strip alone when the ids are not a permutation of it", async () => {
    const { reorderCachedViews } = await import("./views.logic");

    const drifted = [
      // A view created or renamed elsewhere since the drag started.
      ["overview", "table", "files", "created-elsewhere"],
      // One deleted elsewhere, so the drag carried a short list.
      ["overview", "table", "files"],
      // Longer than the cache: every cached view resolves, one id does not.
      [...CACHED_IDS, "created-elsewhere"],
      // Right length, but a repeat would drop `kanban` off the strip.
      ["overview", "table", "files", "files"],
    ];

    for (const viewIds of drifted) {
      expect(reorderCachedViews(CACHED_VIEWS, viewIds)).toBe(CACHED_VIEWS);
    }
  });

  test("writes nothing when the strip has not been fetched", async () => {
    const { reorderCachedViews } = await import("./views.logic");

    expect(reorderCachedViews(undefined, CACHED_IDS)).toBeUndefined();
  });
});

describe("view reorder cache path", () => {
  test("reorders the cache and reports what it displaced", async () => {
    const { viewOrderCache } = await import("./views.logic");
    const queryClient = await seededClient();

    const context = await viewOrderCache({
      queryClient,
      workspaceId: WORKSPACE_ID,
    }).apply(["table", "overview", "files", "kanban"]);

    expect(await cachedOrder(queryClient)).toEqual([
      "table",
      "overview",
      "files",
      "kanban",
    ]);
    expect(context.previousViews?.map((cached) => cached.id)).toEqual(
      CACHED_IDS,
    );
  });

  test("puts the previous order back when the reorder fails", async () => {
    const { viewOrderCache } = await import("./views.logic");
    const queryClient = await seededClient();
    const cache = viewOrderCache({ queryClient, workspaceId: WORKSPACE_ID });

    const moved = ["kanban", ...CACHED_IDS.slice(0, 3)];
    const context = await cache.apply(moved);
    // Without this the test would pass on an `apply` that never wrote.
    expect(await cachedOrder(queryClient)).toEqual(moved);

    cache.restore(context);

    expect(await cachedOrder(queryClient)).toEqual(CACHED_IDS);
  });

  test("keeps a later drop's order when an earlier reorder fails", async () => {
    const { viewOrderCache } = await import("./views.logic");
    const queryClient = await seededClient();
    const cache = viewOrderCache({ queryClient, workspaceId: WORKSPACE_ID });

    // Two drops in flight at once: nothing disables the strip between them.
    const first = ["kanban", ...CACHED_IDS.slice(0, 3)];
    const second = [...CACHED_IDS.slice(1), "overview"];
    const firstContext = await cache.apply(first);
    await cache.apply(second);

    cache.restore(firstContext);

    expect(await cachedOrder(queryClient)).toEqual(second);
  });

  test("invalidates every cached locale variant and navigation projection on settle", async () => {
    const { workspacesKeys } = await import("@/lib/workspaces/queries.logic");
    const { viewsKeys } = await import("@/lib/workspaces/queries/views");
    const { viewOrderCache } = await import("./views.logic");
    const queryClient = await seededClient();

    // Default view names are localized server-side, so a reorder must reach the
    // variants the current locale did not write to. Keyed off `all` rather than
    // a second literal, so the test still covers the prefix if the key changes.
    const otherLocaleKey = [...viewsKeys.all(WORKSPACE_ID), "xx-other"];
    queryClient.setQueryData(otherLocaleKey, CACHED_VIEWS);
    const navigationKey = workspacesKeys.navigation("org_navigation");
    const unrelatedWorkspaceListKey = workspacesKeys.list("org_navigation");
    queryClient.setQueryData(navigationKey, { workspaces: [] });
    queryClient.setQueryData(unrelatedWorkspaceListKey, { workspaces: [] });

    await viewOrderCache({ queryClient, workspaceId: WORKSPACE_ID }).settle();

    for (const key of [viewsKeys.localized(WORKSPACE_ID), otherLocaleKey]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(navigationKey)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(unrelatedWorkspaceListKey)?.isInvalidated,
    ).toBe(false);
  });
});
