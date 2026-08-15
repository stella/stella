import { panic } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  deleteMemory,
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
  test("reads memory pages and sends the opaque cursor", async () => {
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
    const url = requestUrl(input);
    expect(url.pathname).toBe("/v1/memories");
    expect(url.searchParams.get("cursor")).toBe("current_page");
    expect(url.searchParams.get("workspaceId")).toBe("workspace_1");
  });

  test("reads navigation pages and restores Date values", async () => {
    setFetch(async () =>
      Response.json({
        items: [workspaceNavigationItem],
        limit: 100,
        nextCursor: null,
        workspaces: [workspaceNavigationItem],
      }),
    );

    const page = await fetchWorkspaceNavigationPage({
      statusScope: "active-and-archived",
    });

    expect(page.items.at(0)?.status).toBe("archived");
    expect(page.items.at(0)?.lastActivityAt).toBeInstanceOf(Date);
  });

  test("sends update bodies through the typed route", async () => {
    const memoryId = "00000000-0000-0000-0000-000000000001";
    const fetchMock = setFetch(async () => Response.json({ id: memoryId }));

    const result = await updateMemory({
      body: { status: "active" },
      memoryId,
    });

    expect(String(result.id)).toBe(memoryId);
    const [input, init] = fetchMock.mock.calls.at(0) ?? [];
    expect(requestUrl(input).pathname).toBe(`/v1/memories/${memoryId}`);
    expect(init).toMatchObject({
      body: JSON.stringify({ status: "active" }),
      credentials: "include",
      method: "PATCH",
    });
  });

  test("permanently deletes a memory through the typed route", async () => {
    const memoryId = "00000000-0000-0000-0000-000000000001";
    const fetchMock = setFetch(async () => Response.json({ id: memoryId }));

    const result = await deleteMemory(memoryId);

    expect(String(result.id)).toBe(memoryId);
    const [input, init] = fetchMock.mock.calls.at(0) ?? [];
    expect(requestUrl(input).pathname).toBe(`/v1/memories/${memoryId}`);
    expect(init).toMatchObject({
      credentials: "include",
      method: "DELETE",
    });
  });
});

const workspaceNavigationItem = {
  client: null,
  clientId: null,
  color: null,
  defaultViewId: "view_1",
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

const requestUrl = (input: Parameters<typeof fetch>[0] | undefined): URL => {
  if (input === undefined) {
    return panic("Expected fetch to be called");
  }
  return new URL(input instanceof Request ? input.url : input);
};
