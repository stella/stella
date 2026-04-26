import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ScopedDb, Transaction } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const searchMock = mock();
const getSearchProviderMock = mock(() => ({
  search: searchMock,
}));

void mock.module("@/api/lib/search/provider", () => ({
  getSearchProvider: getSearchProviderMock,
}));

const { searchHandler } = await import("@/api/handlers/search/search");

const organizationId = toSafeId<"organization">("org_1");
const accessibleWorkspaceIds = [
  toSafeId<"workspace">("ws_1"),
  toSafeId<"workspace">("ws_2"),
];

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("scopedDb should not be called");
};

const createWorkspaceLookupScopedDb =
  (findFirst: (query: unknown) => Promise<unknown>): ScopedDb =>
  async (callback) => {
    const tx = {
      query: {
        workspaces: {
          findFirst,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only implements workspaces.findFirst
    return await callback(tx as unknown as Transaction);
  };

describe("search handler workspace scoping", () => {
  beforeEach(() => {
    getSearchProviderMock.mockReset();
    searchMock.mockReset();
    getSearchProviderMock.mockImplementation(() => ({
      search: searchMock,
    }));
    searchMock.mockResolvedValue({
      facets: { kind: [], workspace: [] },
      hits: [],
      nextCursor: null,
      totalCount: 0,
    });
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
      kinds: undefined,
      limit: LIMITS.searchPageSizeDefault,
      organizationId: "org_1",
      query: "closing memo",
      workspaceId: undefined,
      workspaceIds: ["ws_1", "ws_2"],
    });
  });

  test("keeps the accessible workspace allowlist when a workspace is selected", async () => {
    const workspaceId = toSafeId<"workspace">("ws_1");
    const findFirstMock = mock(async () => ({ id: workspaceId }));

    await searchHandler({
      accessibleWorkspaceIds,
      body: {
        query: "closing memo",
        workspaceId,
      },
      organizationId,
      scopedDb: createWorkspaceLookupScopedDb(findFirstMock),
    });

    expect(findFirstMock).toHaveBeenCalledWith({
      columns: { id: true },
      where: {
        id: { eq: workspaceId },
        organizationId: { eq: organizationId },
        status: { ne: "deleting" },
      },
    });
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        query: "closing memo",
        workspaceId: "ws_1",
        workspaceIds: ["ws_1", "ws_2"],
      }),
    );
  });
});
