import { toJsonSchema } from "@valibot/to-json-schema";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";

import {
  createSearchSummaryChatThread,
  refineSearchOutputSchema,
  searchSummaryOutputSchema,
} from "@/api/handlers/search/ai";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import {
  clearRootDbMocks,
  rootDbSelectMock,
} from "@/api/tests/helpers/mock-root-db";
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
const upsertSearchDocumentMock = mock(async () => undefined);

beforeEach(() => {
  searchGlobalMock.mockReset();
  upsertSearchDocumentMock.mockClear();
  clearRootDbMocks();
});

const emptySearchSummaryFilters = () => ({
  editedByUserIds: [],
  mimeTypes: [],
  types: [],
  workspaceIds: [],
});

const noopAuditRecorder = mock(async () => {});

const entitySearchIdentity = (entityId: string) => {
  const resource = resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: toSafeId<"entity">(entityId),
  });
  return {
    id: `entity:${entityId}`,
    resource,
    resourceName: toResourceName(resource),
  };
};

describe("search AI output schemas", () => {
  test("convert to JSON Schema for structured model output", async () => {
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
      select: rootDbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          ...entitySearchIdentity("entity_1"),
          entityId: "entity_1",
          headline: null,
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
      upsertSearchDocument: upsertSearchDocumentMock,
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
        expect.objectContaining({
          memoryExtractionEligible: false,
          role: "user",
          workspaceId: null,
        }),
        expect.objectContaining({
          memoryExtractionEligible: false,
          role: "assistant",
          workspaceId: null,
        }),
      ]),
    );
  });

  test("does not let chat hits consume the summary search limit", async () => {
    const organizationId = toSafeId<"organization">("org_1");
    const workspaceId = toSafeId<"workspace">("ws_1");
    const tx = {
      query: {
        workspaces: {
          findMany: mock(async () => [{ id: workspaceId }]),
        },
      },
      insert: mock((_table: unknown) => ({
        values: mock(async (_values: unknown) => {}),
      })),
      select: rootDbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          ...entitySearchIdentity("entity_1"),
          entityId: "entity_1",
          headline: null,
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

    await createSearchSummaryChatThread({
      accessibleWorkspaceIds: [workspaceId],
      body: {
        ...emptySearchSummaryFilters(),
        citations: [{ number: 1 }],
        limit: 1,
        query: "motion",
        summary: "Relevant document [1].",
        title: "Search summary",
        types: ["chat", "document"],
        workspaceIds: [workspaceId],
      },
      organizationId,
      safeDb,
      search: searchGlobalMock,
      upsertSearchDocument: upsertSearchDocumentMock,
      scopedDb,
      userId: toSafeId<"user">("user_1"),
      recordAuditEvent: noopAuditRecorder,
    });

    const call = searchGlobalMock.mock.calls.at(0)?.[0];
    expect(call).toMatchObject({ types: ["document"] });
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
      select: rootDbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          ...entitySearchIdentity("entity_1"),
          entityId: "entity_1",
          headline: null,
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
      upsertSearchDocument: upsertSearchDocumentMock,
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
      select: rootDbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          ...entitySearchIdentity("entity_1"),
          entityId: "entity_1",
          headline: null,
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
          ...entitySearchIdentity("entity_2"),
          entityId: "entity_2",
          headline: null,
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
      upsertSearchDocument: upsertSearchDocumentMock,
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
      select: rootDbSelectMock,
    };
    const { safeDb, scopedDb } = createScopedDbMock(tx);

    searchGlobalMock.mockResolvedValueOnce({
      facets: { editor: [], mimeType: [], type: [], workspace: [] },
      hits: [
        {
          ...entitySearchIdentity("entity_1"),
          entityId: "entity_1",
          headline: null,
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
      upsertSearchDocument: upsertSearchDocumentMock,
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
