import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ScopedDb, Transaction } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const searchMock = mock();

void mock.module("@/api/lib/search/index-global", () => ({
  searchGlobal: searchMock,
}));

const { searchHandler } = await import("@/api/handlers/search/search");

const realDateNow = Date.now;

const organizationId = toSafeId<"organization">("org_1");
const accessibleWorkspaceIds = [
  toSafeId<"workspace">("ws_1"),
  toSafeId<"workspace">("ws_2"),
];

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("scopedDb should not be called");
};

const createWorkspaceLookupScopedDb =
  (findMany: (query: unknown) => Promise<unknown>): ScopedDb =>
  async (callback) => {
    const tx = {
      query: {
        workspaces: {
          findMany,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only implements workspaces.findMany
    return await callback(tx as unknown as Transaction);
  };

describe("search handler workspace scoping", () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [],
      nextCursor: null,
      totalCount: 0,
    });
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  test("passes the caller's accessible workspace allowlist for global searches", async () => {
    await searchHandler({
      accessibleWorkspaceIds,
      body: {
        query: "closing memo",
      },
      organizationId,
      scopedDb: unusedScopedDb,
    });

    expect(searchMock).toHaveBeenCalledWith({
      cursor: undefined,
      limit: LIMITS.searchPageSizeDefault,
      organizationId: "org_1",
      query: "closing memo",
      types: undefined,
      editedByUserIds: undefined,
      mimeTypes: undefined,
      updatedFrom: undefined,
      updatedTo: undefined,
      accessibleWorkspaceIds: ["ws_1", "ws_2"],
      selectedWorkspaceIds: [],
    });
  });

  test("validates and forwards the user's workspace selection", async () => {
    const workspaceId = toSafeId<"workspace">("ws_1");
    const findManyMock = mock(async () => [{ id: workspaceId }]);

    await searchHandler({
      accessibleWorkspaceIds,
      body: {
        query: "closing memo",
        workspaceIds: [workspaceId],
      },
      organizationId,
      scopedDb: createWorkspaceLookupScopedDb(findManyMock),
    });

    expect(findManyMock).toHaveBeenCalledWith({
      columns: { id: true },
      where: {
        id: { in: [workspaceId] },
        organizationId: { eq: organizationId },
        status: { ne: "deleting" },
      },
    });
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessibleWorkspaceIds: ["ws_1", "ws_2"],
        selectedWorkspaceIds: [workspaceId],
        organizationId: "org_1",
        query: "closing memo",
      }),
    );
  });

  test("dedupes duplicate workspace ids before validation", async () => {
    const workspaceId = toSafeId<"workspace">("ws_1");
    const findManyMock = mock(async () => [{ id: workspaceId }]);

    await searchHandler({
      accessibleWorkspaceIds,
      body: {
        query: "closing memo",
        workspaceIds: [workspaceId, workspaceId, workspaceId],
      },
      organizationId,
      scopedDb: createWorkspaceLookupScopedDb(findManyMock),
    });

    expect(findManyMock).toHaveBeenCalledWith({
      columns: { id: true },
      where: {
        id: { in: [workspaceId] },
        organizationId: { eq: organizationId },
        status: { ne: "deleting" },
      },
    });
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedWorkspaceIds: [workspaceId],
      }),
    );
  });

  test("rejects workspace ids the caller cannot access", async () => {
    const result = await searchHandler({
      accessibleWorkspaceIds,
      body: {
        query: "closing memo",
        workspaceIds: [toSafeId<"workspace">("ws_other")],
      },
      organizationId,
      scopedDb: unusedScopedDb,
    });

    expect(result).toMatchObject({
      code: 400,
      response: { message: "Workspace not found in organization" },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  test("passes editor, MIME, and date range filters to global search", async () => {
    await searchHandler({
      accessibleWorkspaceIds,
      body: {
        editedByUserIds: ["user_1", "user_2"],
        mimeTypes: ["application/pdf"],
        query: "closing memo",
        updatedFrom: "2026-04-23T12:00:00.000Z",
        updatedTo: "2026-04-30T12:00:00.000Z",
      },
      organizationId,
      scopedDb: unusedScopedDb,
    });

    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        editedByUserIds: ["user_1", "user_2"],
        mimeTypes: ["application/pdf"],
        updatedFrom: "2026-04-23T12:00:00.000Z",
        updatedTo: "2026-04-30T12:00:00.000Z",
      }),
    );
  });
});
