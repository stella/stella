import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { FolioAIEditOperation } from "@stll/folio-core/ai-edits";

import { docxSuggestions, entities } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import rejectPendingDocxSuggestions from "@/api/handlers/docx-suggestions/reject-pending";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type WorkspaceTestContext = {
  memberRole: { role: "owner" };
  request: Request;
  route: string;
  recordAuditEvent: () => Promise<void>;
  safeDb: ReturnType<typeof createSafeDb<TestDatabaseTransaction>>;
  scopedDb: ReturnType<typeof createScopedDb<TestDatabaseTransaction>>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  workspaceId: SafeId<"workspace">;
};

let testDb: TestDatabase;
let ids: TestIds;
// A second document in workspace A, so an id from another entity of the same
// workspace can be sent to the endpoint.
const siblingEntityId = createSafeId<"entity">();

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb.insert(entities).values({
    id: siblingEntityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name: "siblingEntity",
  });
});

afterAll(async () => {
  await releaseTestDb();
});

describe("bulk rejecting pending docx suggestions", () => {
  test("rejects only the pending rows of the addressed entity", async () => {
    const pendingA = await insertSuggestion();
    const pendingB = await insertSuggestion();
    const alreadyAccepted = await insertSuggestion({
      status: "accepted",
      appliedMode: "direct",
      resolvedByUserId: ids.userA1,
      resolvedAt: new Date(),
    });
    const otherEntity = await insertSuggestion({ entityId: siblingEntityId });

    const result = await runHandler(
      rejectPendingDocxSuggestions,
      workspaceAContext(),
      {
        params: { workspaceId: ids.wsA1, entityId: ids.entityA1 },
        body: {
          suggestionIds: [pendingA, pendingB, alreadyAccepted, otherEntity],
        },
      },
    );

    expect(result).toEqual({
      rejectedIds: expect.arrayContaining([pendingA, pendingB]),
    });
    for (const skipped of [alreadyAccepted, otherEntity]) {
      expect(result).not.toEqual({
        rejectedIds: expect.arrayContaining([skipped]),
      });
    }

    for (const suggestionId of [pendingA, pendingB]) {
      const row = await readSuggestion(suggestionId);
      expect(row?.status).toBe("rejected");
      expect(row?.appliedMode).toBeNull();
      expect(row?.resolvedByUserId).toBe(ids.userA1);
    }

    const accepted = await readSuggestion(alreadyAccepted);
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.appliedMode).toBe("direct");

    const untouched = await readSuggestion(otherEntity);
    expect(untouched?.status).toBe("pending");
    expect(untouched?.resolvedByUserId).toBeNull();
  });

  test("a second reject of the same ids rejects nothing", async () => {
    const suggestionId = await insertSuggestion();
    const request = {
      params: { workspaceId: ids.wsA1, entityId: ids.entityA1 },
      body: { suggestionIds: [suggestionId] },
    };

    const first = await runHandler(
      rejectPendingDocxSuggestions,
      workspaceAContext(),
      request,
    );
    expect(first).toEqual({ rejectedIds: [suggestionId] });

    const second = await runHandler(
      rejectPendingDocxSuggestions,
      workspaceAContext(),
      request,
    );
    expect(second).toEqual({ rejectedIds: [] });
  });

  test("a workspace cannot reject another workspace's suggestions", async () => {
    const suggestionId = await insertSuggestion();

    const result = await runHandler(
      rejectPendingDocxSuggestions,
      workspaceBContext(),
      {
        params: { workspaceId: ids.wsA1, entityId: ids.entityA1 },
        body: { suggestionIds: [suggestionId] },
      },
    );
    expect(result).toEqual({ rejectedIds: [] });

    const row = await readSuggestion(suggestionId);
    expect(row?.status).toBe("pending");
    expect(row?.resolvedByUserId).toBeNull();
  });
});

type SuggestionOverrides = Partial<typeof docxSuggestions.$inferInsert>;

const insertSuggestion = async (
  overrides: SuggestionOverrides = {},
): Promise<SafeId<"docxSuggestion">> => {
  const suggestionId = createSafeId<"docxSuggestion">();
  await testDb.insert(docxSuggestions).values({
    id: suggestionId,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    opPayload: {
      id: "reject-pending",
      type: "replaceInBlock",
      blockId: "block-1",
      find: "before",
      replace: "after",
    } satisfies FolioAIEditOperation,
    severity: "medium",
    area: "body",
    status: "pending",
    ...overrides,
  });
  return suggestionId;
};

const readSuggestion = async (suggestionId: SafeId<"docxSuggestion">) => {
  const rows = await testDb
    .select({
      status: docxSuggestions.status,
      appliedMode: docxSuggestions.appliedMode,
      resolvedByUserId: docxSuggestions.resolvedByUserId,
    })
    .from(docxSuggestions)
    .where(eq(docxSuggestions.id, suggestionId));
  return rows.at(0);
};

const workspaceAContext = (): WorkspaceTestContext =>
  createWorkspaceContext({
    workspaceId: ids.wsA1,
    organizationId: ids.orgA,
    userId: ids.userA1,
  });

const workspaceBContext = (): WorkspaceTestContext =>
  createWorkspaceContext({
    workspaceId: ids.wsB1,
    organizationId: ids.orgB,
    userId: ids.userB1,
  });

const createWorkspaceContext = ({
  workspaceId,
  organizationId,
  userId,
}: {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): WorkspaceTestContext => {
  const activeWorkspaceIds = [workspaceId];
  return {
    memberRole: { role: "owner" },
    request: new Request(
      `https://example.test/docx-suggestions/${workspaceId}`,
    ),
    route: "/security/docx-suggestions-reject-pending",
    recordAuditEvent: async () => {},
    safeDb: createSafeDb(testDb, activeWorkspaceIds, organizationId, userId),
    scopedDb: createScopedDb(
      testDb,
      activeWorkspaceIds,
      organizationId,
      userId,
    ),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  };
};

const runHandler = async <TContext>(
  endpoint: { handler: (context: TContext) => Promise<unknown> },
  context: WorkspaceTestContext,
  requestShape: Partial<TContext> & Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw<TContext>({ ...context, ...requestShape }),
    );
  } catch (error) {
    return error;
  }
};
