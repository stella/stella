import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import type { ViewLayout, WorkspaceView } from "@/lib/types";

beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const WORKSPACE_ID = "workspace-with-cached-views";
const VIEW_ID = "cached-overview";
const originalFetch = globalThis.fetch;

const OVERVIEW_LAYOUT = {
  filters: [],
  hiddenProperties: [],
  calculations: [],
  sorts: [],
  type: "overview",
  version: 1,
} as const satisfies ViewLayout;

const CACHED_VIEWS = [
  {
    version: 1,
    id: VIEW_ID,
    name: "Overview",
    layout: OVERVIEW_LAYOUT,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
] satisfies WorkspaceView[];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("default workspace view redirect", () => {
  test("reuses the route-prefetched view list", async () => {
    const { resolveDefaultWorkspaceViewTarget } =
      await import("./-default-view-redirect");
    const { viewsOptions } = await import("@/lib/workspaces/queries/views");
    const options = viewsOptions(WORKSPACE_ID);
    const queryClient = new QueryClient();
    queryClient.setQueryData(options.queryKey, CACHED_VIEWS);
    const fetchMock = mock(async () => {
      throw new Error("The cached view list should not be fetched again");
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });

    const target = await resolveDefaultWorkspaceViewTarget({
      queryClient,
      workspaceId: WORKSPACE_ID,
    });

    expect(target).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId: WORKSPACE_ID, viewId: VIEW_ID },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
