import { toJsonSchema } from "@valibot/to-json-schema";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["TRANSACTIONAL_EMAIL_FROM"] ??= "test@example.com";
process.env["FRONTEND_URL"] ??= "http://localhost:3000";
process.env["BETTER_AUTH_SECRET"] ??= "x".repeat(32);
process.env["BETTER_AUTH_URL"] ??= "http://localhost:3001";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const searchGlobalMock = mock();
const dbLimitMock = mock(async () => [{ searchableText: "Document content" }]);
const dbWhereMock = mock(() => ({ limit: dbLimitMock }));
const dbFromMock = mock(() => ({ where: dbWhereMock }));
const dbSelectMock = mock(() => ({ from: dbFromMock }));

// eslint-disable-next-line typescript-eslint/no-floating-promises -- Bun mock.module is sync for registration
mock.module("@/api/db/root", () => ({
  rootDb: {
    select: dbSelectMock,
  },
}));

// Mock index-global directly to prevent transitive db/root imports that
// require a live database connection and cause flaky failures in CI.
// eslint-disable-next-line typescript-eslint/no-floating-promises -- Bun mock.module is sync for registration
mock.module("@/api/lib/search/index-global", () => ({
  rebuildSupplementalSearchIndex: mock(async () => undefined),
  reindexWorkspacesForContact: mock(async () => undefined),
  searchGlobal: searchGlobalMock,
  searchGlobalFacet: mock(async () => []),
  syncWorkspaceSearchActivity: mock(async () => undefined),
  upsertContactSearchDocument: mock(async () => undefined),
  upsertWorkspaceSearchDocument: mock(async () => undefined),
  upsertWorkspaceSearchDocuments: mock(async () => undefined),
}));

beforeEach(() => {
  searchGlobalMock.mockReset();
  dbSelectMock.mockClear();
  dbFromMock.mockClear();
  dbWhereMock.mockClear();
  dbLimitMock.mockClear();
});

const emptySearchSummaryFilters = () => ({
  editedByUserIds: [],
  mimeTypes: [],
  types: [],
  workspaceIds: [],
});

const noopAuditRecorder = mock(async () => {});

describe("search AI output schemas", () => {
  test("convert to JSON Schema for structured model output", async () => {
    const { refineSearchOutputSchema, searchSummaryOutputSchema } =
      await import("@/api/handlers/search/ai");

    expect(() => toJsonSchema(refineSearchOutputSchema)).not.toThrow();
    expect(() => toJsonSchema(searchSummaryOutputSchema)).not.toThrow();
  });
});

describe("search summary chat", () => {
  test("stores global summary chat thread when a workspace filter is set", async () => {
    const organizationId = toSafeId<"organization">("org_1");
    const workspaceId = toSafeId<"workspace">("ws_1");
    const insertedValues: unknown[] = [];
    const tx = {
      query: {
        workspaces: {
          findMany: mock(async () => [{ id: workspaceId }]),
        },
      },
      insert: mock((_table: unknown) => ({
        values: mock(async (values: unknown) => {
          insertedValues.push(values);
        }),
      })),
      select: dbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          entityId: "entity_1",
          headline: null,
          id: "entity:entity_1",
          lastEditedByImage: null,
          lastEditedByName: null,
          mimeType: "application/pdf",
          title: "Motion.pdf",
          type: "document",
          updatedAt: "2026-04-30T08:00:00.000Z",
          workspaceId,
          workspaceName: "Motion matter",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });

    const { createSearchSummaryChatThread } =
      await import("@/api/handlers/search/ai");
    const result = await createSearchSummaryChatThread({
      accessibleWorkspaceIds: [workspaceId],
      body: {
        ...emptySearchSummaryFilters(),
        citations: [{ number: 1 }],
        limit: 1,
        query: "motion",
        summary: "Relevant document [1].",
        title: "Search summary",
        workspaceIds: [workspaceId],
      },
      organizationId,
      safeDb,
      search: searchGlobalMock,
      scopedDb,
      userId: toSafeId<"user">("user_1"),
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toHaveProperty("threadId");
    expect(insertedValues.at(0)).toMatchObject({
      workspaceId: null,
      // Regression: the data scope must include the contributing
      // workspace so the thread becomes invisible (RLS) the moment
      // the user loses access to it. An empty array would leak the
      // stored summary back via the global chat list.
      dataWorkspaceIds: [workspaceId],
    });
    expect(insertedValues.at(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", workspaceId: null }),
        expect.objectContaining({ role: "assistant", workspaceId: null }),
      ]),
    );
  });

  test("stores global summary chat thread for unfiltered summary chats", async () => {
    const organizationId = toSafeId<"organization">("org_1");
    const workspaceId = toSafeId<"workspace">("ws_1");
    const insertedValues: unknown[] = [];
    const tx = {
      query: { workspaces: {} },
      insert: mock((_table: unknown) => ({
        values: mock(async (values: unknown) => {
          insertedValues.push(values);
        }),
      })),
      select: dbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          entityId: "entity_1",
          headline: null,
          id: "entity:entity_1",
          lastEditedByImage: null,
          lastEditedByName: null,
          mimeType: "application/pdf",
          title: "Motion.pdf",
          type: "document",
          updatedAt: "2026-04-30T08:00:00.000Z",
          workspaceId,
          workspaceName: "Motion matter",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });

    const { createSearchSummaryChatThread } =
      await import("@/api/handlers/search/ai");
    const result = await createSearchSummaryChatThread({
      accessibleWorkspaceIds: [workspaceId],
      body: {
        ...emptySearchSummaryFilters(),
        citations: [{ number: 1 }],
        limit: 1,
        query: "motion",
        summary: "Relevant document [1].",
        title: "Search summary",
      },
      organizationId,
      safeDb,
      search: searchGlobalMock,
      scopedDb,
      userId: toSafeId<"user">("user_1"),
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toHaveProperty("threadId");
    expect(insertedValues.at(0)).toMatchObject({
      workspaceId: null,
      // Even without an explicit workspace filter, the data scope
      // must reflect the workspace of every embedded hit. Otherwise
      // a user who loses access to a hit's workspace would still
      // see the stored summary.
      dataWorkspaceIds: [workspaceId],
    });
    expect(insertedValues.at(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", workspaceId: null }),
        expect.objectContaining({ role: "assistant", workspaceId: null }),
      ]),
    );
  });

  test("stores global summary chat thread when hits span multiple workspaces", async () => {
    const organizationId = toSafeId<"organization">("org_1");
    const firstWorkspaceId = toSafeId<"workspace">("ws_1");
    const secondWorkspaceId = toSafeId<"workspace">("ws_2");
    const insertedValues: unknown[] = [];
    const insertMock = mock((_table: unknown) => ({
      values: mock(async (values: unknown) => {
        insertedValues.push(values);
      }),
    }));
    const tx = {
      query: { workspaces: {} },
      insert: insertMock,
      select: dbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          entityId: "entity_1",
          headline: null,
          id: "entity:entity_1",
          lastEditedByImage: null,
          lastEditedByName: null,
          mimeType: "application/pdf",
          title: "First.pdf",
          type: "document",
          updatedAt: "2026-04-30T08:00:00.000Z",
          workspaceId: firstWorkspaceId,
          workspaceName: "First matter",
        },
        {
          entityId: "entity_2",
          headline: null,
          id: "entity:entity_2",
          lastEditedByImage: null,
          lastEditedByName: null,
          mimeType: "application/pdf",
          title: "Second.pdf",
          type: "document",
          updatedAt: "2026-04-30T08:00:00.000Z",
          workspaceId: secondWorkspaceId,
          workspaceName: "Second matter",
        },
      ],
      nextCursor: null,
      totalCount: 2,
    });

    const { createSearchSummaryChatThread } =
      await import("@/api/handlers/search/ai");
    const result = await createSearchSummaryChatThread({
      accessibleWorkspaceIds: [firstWorkspaceId, secondWorkspaceId],
      body: {
        ...emptySearchSummaryFilters(),
        citations: [{ number: 1 }],
        limit: 2,
        query: "motion",
        summary: "Relevant documents [1].",
        title: "Search summary",
      },
      organizationId,
      safeDb,
      search: searchGlobalMock,
      scopedDb,
      userId: toSafeId<"user">("user_1"),
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toHaveProperty("threadId");
    expect(insertMock).toHaveBeenCalled();
    const inserted = insertedValues.at(0);
    expect(inserted).toMatchObject({ workspaceId: null });
    // Multi-workspace summaries must record EVERY contributing
    // workspace; RLS rejects the read if the user loses access to
    // ANY of them. Order is not guaranteed, so compare as a set.
    expect(new Set(extractDataWorkspaceIds(inserted))).toEqual(
      new Set([firstWorkspaceId, secondWorkspaceId]),
    );
    expect(insertedValues.at(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", workspaceId: null }),
        expect.objectContaining({ role: "assistant", workspaceId: null }),
      ]),
    );
  });

  test("regression: never stores a global summary thread without a data scope", async () => {
    // A summary chat with no workspace data scope would be visible
    // through the global chat list to any user who keeps the same
    // user_id, regardless of their current workspace access. The
    // RLS policy permits empty `data_workspace_ids` only for true
    // global chats — any thread that embeds workspace content must
    // record those workspaces here.
    const organizationId = toSafeId<"organization">("org_1");
    const workspaceId = toSafeId<"workspace">("ws_1");
    const insertedValues: unknown[] = [];
    const tx = {
      query: { workspaces: {} },
      insert: mock((_table: unknown) => ({
        values: mock(async (values: unknown) => {
          insertedValues.push(values);
        }),
      })),
      select: dbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          entityId: "entity_1",
          headline: null,
          id: "entity:entity_1",
          lastEditedByImage: null,
          lastEditedByName: null,
          mimeType: "application/pdf",
          title: "Motion.pdf",
          type: "document",
          updatedAt: "2026-04-30T08:00:00.000Z",
          workspaceId,
          workspaceName: "Motion matter",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });

    const { createSearchSummaryChatThread } =
      await import("@/api/handlers/search/ai");
    await createSearchSummaryChatThread({
      accessibleWorkspaceIds: [workspaceId],
      body: {
        ...emptySearchSummaryFilters(),
        citations: [{ number: 1 }],
        limit: 1,
        query: "motion",
        summary: "Relevant document [1].",
        title: "Search summary",
      },
      organizationId,
      safeDb,
      search: searchGlobalMock,
      scopedDb,
      userId: toSafeId<"user">("user_1"),
      recordAuditEvent: noopAuditRecorder,
    });

    const inserted = insertedValues.at(0);
    const dataIds = extractDataWorkspaceIds(inserted);
    expect(dataIds.length).toBeGreaterThan(0);
    expect(dataIds).toContain(workspaceId);
  });
});

const extractDataWorkspaceIds = (
  value: unknown,
): readonly SafeId<"workspace">[] => {
  if (
    typeof value === "object" &&
    value !== null &&
    "dataWorkspaceIds" in value &&
    Array.isArray(value.dataWorkspaceIds)
  ) {
    return value.dataWorkspaceIds;
  }
  return [];
};
