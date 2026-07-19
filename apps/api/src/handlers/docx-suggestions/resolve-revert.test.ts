import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
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
  safeDb: ReturnType<typeof createSafeDb<TestDatabaseTransaction>>;
  scopedDb: ReturnType<typeof createScopedDb<TestDatabaseTransaction>>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  workspaceId: SafeId<"workspace">;
};

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

describe("docx suggestion resolve/revert state transitions", () => {
  test("resolving a pending suggestion records the resolution and rejects a second resolve", async () => {
    const suggestionId = await insertSuggestion();
    const context = workspaceAContext();
    const params = {
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      suggestionId,
    };

    const first = await runHandler(resolveDocxSuggestion, context, {
      params,
      body: { status: "accepted", appliedMode: "direct" },
    });
    expect(first).toEqual({ updated: true });

    const afterFirst = await readSuggestion(suggestionId);
    expect(afterFirst?.status).toBe("accepted");
    expect(afterFirst?.appliedMode).toBe("direct");
    expect(afterFirst?.resolvedByUserId).toBe(ids.userA1);

    // A second resolve finds no pending row (WHERE status = 'pending'): the
    // affected-row count is authoritative, so this is a `{ updated: false }`
    // no-op rather than a silent double-write that would overwrite the mode.
    const second = await runHandler(resolveDocxSuggestion, context, {
      params,
      body: { status: "rejected" },
    });
    expect(second).toEqual({ updated: false });

    const afterSecond = await readSuggestion(suggestionId);
    expect(afterSecond?.status).toBe("accepted");
    expect(afterSecond?.appliedMode).toBe("direct");
  });

  test("rejecting a pending suggestion stores no applied mode", async () => {
    const suggestionId = await insertSuggestion();

    const result = await runHandler(
      resolveDocxSuggestion,
      workspaceAContext(),
      {
        params: { workspaceId: ids.wsA1, entityId: ids.entityA1, suggestionId },
        body: { status: "rejected" },
      },
    );
    expect(result).toEqual({ updated: true });

    const row = await readSuggestion(suggestionId);
    expect(row?.status).toBe("rejected");
    expect(row?.appliedMode).toBeNull();
    expect(row?.resolvedByUserId).toBe(ids.userA1);
  });

  test("reverting a resolved suggestion clears the trail and rejects a second revert", async () => {
    const suggestionId = await insertSuggestion({
      status: "accepted",
      appliedMode: "direct",
      resolvedByUserId: ids.userA1,
      resolvedAt: new Date(),
    });
    const context = workspaceAContext();
    const params = {
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      suggestionId,
    };

    const first = await runHandler(revertDocxSuggestion, context, { params });
    expect(first).toEqual({ updated: true });

    const afterFirst = await readSuggestion(suggestionId);
    expect(afterFirst?.status).toBe("pending");
    expect(afterFirst?.appliedMode).toBeNull();
    expect(afterFirst?.resolvedByUserId).toBeNull();

    const second = await runHandler(revertDocxSuggestion, context, { params });
    expect(second).toEqual({ updated: false });
  });

  test("reverting an already-pending suggestion is a no-op", async () => {
    const suggestionId = await insertSuggestion();

    const result = await runHandler(revertDocxSuggestion, workspaceAContext(), {
      params: { workspaceId: ids.wsA1, entityId: ids.entityA1, suggestionId },
    });
    expect(result).toEqual({ updated: false });

    const row = await readSuggestion(suggestionId);
    expect(row?.status).toBe("pending");
  });

  test("a workspace cannot resolve another workspace's suggestion", async () => {
    // The row lives in workspace A; workspace B's scoped connection cannot see
    // it, so the RLS-guarded UPDATE affects zero rows even though the params
    // name A's ids. The row must remain untouched.
    const suggestionId = await insertSuggestion();

    const result = await runHandler(
      resolveDocxSuggestion,
      workspaceBContext(),
      {
        params: { workspaceId: ids.wsA1, entityId: ids.entityA1, suggestionId },
        body: { status: "accepted", appliedMode: "direct" },
      },
    );
    expect(result).toEqual({ updated: false });

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
    opPayload: {},
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
    route: "/security/docx-suggestions-transition",
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
