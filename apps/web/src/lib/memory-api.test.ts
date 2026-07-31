import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  fetchMemoriesPage,
  fetchWorkspaceNavigationPage,
  updateMemory,
} from "@/lib/memory-api";

const originalFetch = globalThis.fetch;
type FetchHandler = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("memory API boundary", () => {
  test("validates memory pages and sends the opaque cursor", async () => {
    const fetchMock = setFetch(async () =>
      Response.json({
        items: [
          {
            id: "memory_1",
            scope: "workspace",
            kind: "fact",
            content: "The hearing is remote.",
            language: "en",
            status: "active",
            pinned: false,
            source: "user",
            workspaceId: "workspace_1",
            sourceDataWorkspaceIds: [],
            createdAt: "2026-07-30T12:00:00.000Z",
            updatedAt: "2026-07-30T12:00:00.000Z",
          },
        ],
        limit: 50,
        nextCursor: "next_page",
      }),
    );

    const page = await fetchMemoriesPage({
      cursor: "current_page",
      limit: 50,
      scope: "workspace",
      workspaceId: "workspace_1",
    });

    expect(page.items.at(0)?.status).toBe("active");
    expect(page.nextCursor).toBe("next_page");
    const [input] = fetchMock.mock.calls.at(0) ?? [];
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/memories");
    expect(url.searchParams.get("cursor")).toBe("current_page");
    expect(url.searchParams.get("workspaceId")).toBe("workspace_1");
  });

  test("validates navigation pages and restores Date values", async () => {
    setFetch(async () =>
      Response.json({
        items: [workspaceNavigationItem],
        limit: 100,
        nextCursor: null,
        workspaces: [workspaceNavigationItem],
        workspacesCountLimit: 1000,
      }),
    );

    const page = await fetchWorkspaceNavigationPage({
      statusScope: "active-and-archived",
    });

    expect(page.items.at(0)?.status).toBe("archived");
    expect(page.items.at(0)?.lastActivityAt).toBeInstanceOf(Date);
  });

  test("rejects malformed successes and sends update bodies", async () => {
    const fetchMock = setFetch(async () => Response.json({ id: null }));

    const result = await Result.tryPromise({
      try: async () =>
        await updateMemory({
          body: { status: "active" },
          memoryId: "memory/1",
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ _tag: "ApiError", status: 502 });
    }
    const [input, init] = fetchMock.mock.calls.at(0) ?? [];
    expect(new URL(String(input)).pathname).toBe("/v1/memories/memory%2F1");
    expect(init).toMatchObject({
      body: JSON.stringify({ status: "active" }),
      credentials: "include",
      method: "PATCH",
    });
  });
});

const workspaceNavigationItem = {
  client: null,
  clientId: null,
  color: null,
  id: "workspace_1",
  lastActivityAt: "2026-07-30T12:00:00.000Z",
  name: "Appeal",
  reference: "MAT-001",
  status: "archived",
};

const setFetch = (handler: FetchHandler) => {
  const fetchMock = mock(handler);
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return fetchMock;
};
