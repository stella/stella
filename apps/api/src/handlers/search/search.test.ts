import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ScopedDb, Transaction } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const searchMock = mock();

void mock.module("@/api/lib/search/index-global", () => ({
  searchGlobal: searchMock,
}));

const { resolveUpdatedAfter, searchHandler } =
  await import("@/api/handlers/search/search");

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
      editedByUserId: undefined,
      mimeTypes: undefined,
      updatedAfter: undefined,
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
        updatedAfter: undefined,
        workspaceId: "ws_1",
        workspaceIds: ["ws_1", "ws_2"],
      }),
    );
  });

  test("passes editor, MIME, and time filters to global search", async () => {
    Date.now = () => new Date("2026-04-30T12:00:00.000Z").getTime();

    await searchHandler({
      accessibleWorkspaceIds,
      body: {
        editedByUserId: "user_1",
        mimeTypes: ["application/pdf"],
        query: "closing memo",
        updatedWithin: "week",
      },
      organizationId,
      scopedDb: unusedScopedDb,
    });

    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        editedByUserId: "user_1",
        mimeTypes: ["application/pdf"],
        updatedAfter: "2026-04-23T12:00:00.000Z",
      }),
    );
  });

  test("resolves relative updated filters from the current clock", () => {
    Date.now = () => new Date("2026-04-30T12:00:00.000Z").getTime();

    expect(resolveUpdatedAfter("day")).toBe("2026-04-29T12:00:00.000Z");
    expect(resolveUpdatedAfter(undefined)).toBeUndefined();
  });
});
