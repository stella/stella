import { Value } from "@sinclair/typebox/value";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import { readNamedResearchColumns } from "@/api/handlers/case-law/research/column-access";
import createResearchColumn from "@/api/handlers/case-law/research/columns-create";
import deleteResearchColumn from "@/api/handlers/case-law/research/columns-delete";
import listResearchColumns from "@/api/handlers/case-law/research/columns-list";
import reorderResearchColumns from "@/api/handlers/case-law/research/columns-reorder";
import updateResearchColumn from "@/api/handlers/case-law/research/columns-update";
import { runResearchAnswersBodySchema } from "@/api/handlers/case-law/research/schema";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { queueResearchAnswerCells } from "@/api/lib/case-law/research-answer-queue";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Question columns are owned by the organization, so the organization is the
 * only wall: a column id from another organization must fail the whole
 * request, the cap counts per organization rather than per table, and a run
 * must leave answered cells alone unless it is forced.
 */

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;

const contextFor = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => ({
  createAuditRecorder: () => noopAuditRecorder,
  getActiveWorkspaceIds: async () => [],
  getAccessibleWorkspaces: async () => [],
  getWorkspaceAccess: async () => null,
  memberRole: { role: "owner" },
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  request: new Request("https://example.test/case/research/columns"),
  route: "/case/research/columns",
  safeDb: createSafeDb(testDb, [], organizationId, userId),
  scopedDb: createScopedDb(testDb, [], organizationId, userId),
  session: { activeOrganizationId: organizationId },
  user: { id: userId },
});

type HandlerLike = { handler: (context: never) => Promise<unknown> };

const call = async (
  endpoint: HandlerLike,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
  request: Record<string, unknown> = {},
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw({ ...contextFor(organizationId, userId), ...request }),
    );
  } catch (error) {
    return error;
  }
};

/** A refusal arrives as Elysia's status response: `{ code, response }`. */
const statusOf = (result: unknown): number | null =>
  typeof result === "object" &&
  result !== null &&
  "code" in result &&
  typeof result.code === "number"
    ? result.code
    : null;

const addColumn = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
  question: string,
): Promise<SafeId<"caseLawResearchColumn">> => {
  const created = await call(createResearchColumn, organizationId, userId, {
    body: { question, answerType: "yes_no" },
  });
  if (
    typeof created !== "object" ||
    created === null ||
    !("id" in created) ||
    typeof created.id !== "string"
  ) {
    throw new Error(`Column was not created: ${JSON.stringify(created)}`);
  }
  return toSafeId<"caseLawResearchColumn">(created.id);
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  await testDb.delete(caseLawResearchAnswers).where(sql`true`);
  await testDb.delete(caseLawResearchColumns).where(sql`true`);
});

describe("a question column belongs to one organization", () => {
  test("another organization's column id is not found, for every verb", async () => {
    const columnB = await addColumn(ids.orgB, ids.userB1, "Org B question");

    const read = await readNamedResearchColumns({
      tx: asTestRaw(testDb),
      columnIds: [columnB],
      organizationId: ids.orgA,
    });
    // The gate the run endpoint uses before any cell is marked pending.
    expect(read).toBeNull();

    expect(
      statusOf(
        await call(updateResearchColumn, ids.orgA, ids.userA1, {
          params: { columnId: columnB },
          body: { question: "Taken over" },
        }),
      ),
    ).toBe(404);
    expect(
      statusOf(
        await call(deleteResearchColumn, ids.orgA, ids.userA1, {
          params: { columnId: columnB },
        }),
      ),
    ).toBe(404);
    expect(
      statusOf(
        await call(reorderResearchColumns, ids.orgA, ids.userA1, {
          body: { columnIds: [columnB] },
        }),
      ),
    ).toBe(404);

    // Nothing about org B's column moved.
    const [stored] = await testDb
      .select()
      .from(caseLawResearchColumns)
      .where(eq(caseLawResearchColumns.id, columnB));
    expect(stored?.question).toBe("Org B question");
    expect(stored?.organizationId).toBe(ids.orgB);
  });

  test("the list shows only the caller's own columns", async () => {
    await addColumn(ids.orgA, ids.userA1, "Org A question");
    await addColumn(ids.orgB, ids.userB1, "Org B question");

    const listed = await call(listResearchColumns, ids.orgA, ids.userA1);
    expect(listed).toMatchObject({
      items: [{ question: "Org A question", createdBy: ids.userA1 }],
    });
  });
});

describe("the column cap counts per organization", () => {
  test("the column after the cap is refused, and nothing is written", async () => {
    const cap = LIMITS.caseLawResearchColumnsPerOrganization;
    await testDb.insert(caseLawResearchColumns).values(
      Array.from({ length: cap }, (_unused, index) => ({
        id: createSafeId<"caseLawResearchColumn">(),
        organizationId: ids.orgA,
        createdBy: ids.userA1,
        position: index + 1,
        question: `Question ${index}`,
        answerType: "yes_no" as const,
        tool: { version: 1 as const, role: "fast" as const },
      })),
    );

    const refused = await call(createResearchColumn, ids.orgA, ids.userA1, {
      body: { question: "One too many", answerType: "text" },
    });
    expect(statusOf(refused)).toBe(400);

    const stored = await testDb
      .select({ id: caseLawResearchColumns.id })
      .from(caseLawResearchColumns)
      .where(eq(caseLawResearchColumns.organizationId, ids.orgA));
    expect(stored).toHaveLength(cap);

    // The cap is the organization's, not a shared one: org B still has room.
    const otherOrg = await addColumn(ids.orgB, ids.userB1, "Org B question");
    expect(otherOrg).toBeTruthy();
  });
});

describe("a run answers only the cells that need it", () => {
  const decisionOne = createSafeId<"caseLawDecision">();
  const decisionTwo = createSafeId<"caseLawDecision">();

  const queue = async (
    columnId: SafeId<"caseLawResearchColumn">,
    force: boolean,
    now: Date,
  ): Promise<number> =>
    await testDb.transaction(
      async (tx) =>
        await queueResearchAnswerCells({
          tx: asTestRaw(tx),
          organizationId: ids.orgA,
          columnIds: [columnId],
          decisionIds: [decisionOne, decisionTwo],
          force,
          now,
        }),
    );

  test("an answered cell is kept, unless the caller forces", async () => {
    const columnId = await addColumn(ids.orgA, ids.userA1, "Answered?");
    const answeredAt = new Date("2026-09-01T10:00:00.000Z");
    await testDb.insert(caseLawResearchAnswers).values({
      columnId,
      organizationId: ids.orgA,
      decisionId: decisionOne,
      state: "answered",
      answer: { type: "yes_no", value: "yes" },
      updatedAt: answeredAt,
    });

    expect(await queue(columnId, false, new Date())).toBe(1);
    const [kept] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionOne));
    expect(kept?.state).toBe("answered");
    expect(kept?.updatedAt).toEqual(answeredAt);

    // The second decision is pending from the run above, so only the answered
    // cell is re-queued.
    expect(await queue(columnId, true, new Date())).toBe(1);
    const [forced] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionOne));
    expect(forced?.state).toBe("pending");
    expect(forced?.answer).toBeNull();
  });

  test("a live pending cell is left to its run; a stale one is claimed", async () => {
    const columnId = await addColumn(ids.orgA, ids.userA1, "Pending?");
    const now = new Date("2026-09-01T12:00:00.000Z");
    const live = new Date(now.getTime() - 1000);
    const stale = new Date(
      now.getTime() - LIMITS.caseLawResearchPendingStaleMs - 1000,
    );
    await testDb.insert(caseLawResearchAnswers).values([
      {
        columnId,
        organizationId: ids.orgA,
        decisionId: decisionOne,
        state: "pending",
        updatedAt: live,
      },
      {
        columnId,
        organizationId: ids.orgA,
        decisionId: decisionTwo,
        state: "pending",
        updatedAt: stale,
      },
    ]);

    expect(await queue(columnId, false, now)).toBe(1);
    const [untouched] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionOne));
    expect(untouched?.updatedAt).toEqual(live);
    const [claimed] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionTwo));
    expect(claimed?.updatedAt).toEqual(now);
  });

  test("a run request is bounded by the page size, and oversize is refused", () => {
    const decisionIds = Array.from(
      { length: LIMITS.caseLawResearchRunDecisionsMax },
      () => createSafeId<"caseLawDecision">(),
    );
    expect(Value.Check(runResearchAnswersBodySchema, { decisionIds })).toBe(
      true,
    );
    expect(
      Value.Check(runResearchAnswersBodySchema, {
        decisionIds: [...decisionIds, createSafeId<"caseLawDecision">()],
      }),
    ).toBe(false);
  });

  test("a lookup returns only the caller's organization's cells", async () => {
    const columnA = await addColumn(ids.orgA, ids.userA1, "Org A question");
    const columnB = await addColumn(ids.orgB, ids.userB1, "Org B question");
    await testDb.insert(caseLawResearchAnswers).values([
      {
        columnId: columnA,
        organizationId: ids.orgA,
        decisionId: decisionOne,
        state: "answered",
        answer: { type: "yes_no", value: "yes" },
      },
      {
        columnId: columnB,
        organizationId: ids.orgB,
        decisionId: decisionOne,
        state: "answered",
        answer: { type: "yes_no", value: "no" },
      },
    ]);

    const looked = await call(lookupResearchAnswers, ids.orgA, ids.userA1, {
      body: { decisionIds: [decisionOne] },
    });
    expect(looked).toMatchObject({ items: [{ columnId: columnA }] });
  });
});
