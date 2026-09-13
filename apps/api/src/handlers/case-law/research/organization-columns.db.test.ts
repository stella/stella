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
import type { ResearchAnswerClaim } from "@/api/lib/case-law/research-answer-queue";
import { runResearchAnswers } from "@/api/lib/case-law/research-answer-runner";
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

/**
 * Columns created before the organization owned them were capped per research
 * table, and one member could own many tables, so an organization can hold
 * more columns than it may now add. The cap applies to adding alone: every
 * other verb has to work over the whole held set, or a grandfathered
 * organization loses columns from its results table and can never reorder.
 */
describe("an organization holding more columns than it may add", () => {
  const HELD = LIMITS.caseLawResearchColumnsPerOrganization + 5;
  const decisionId = createSafeId<"caseLawDecision">();

  const holdColumns = async (): Promise<SafeId<"caseLawResearchColumn">[]> => {
    const columnIds = Array.from({ length: HELD }, () =>
      createSafeId<"caseLawResearchColumn">(),
    );
    await testDb.insert(caseLawResearchColumns).values(
      columnIds.map((id, index) => ({
        id,
        organizationId: ids.orgA,
        createdBy: ids.userA1,
        position: index + 1,
        question: `Grandfathered ${index}`,
        answerType: "yes_no" as const,
        tool: { version: 1 as const, role: "fast" as const },
      })),
    );
    return columnIds;
  };

  test("every column lists, looks up, runs and reorders", async () => {
    const columnIds = await holdColumns();

    const listed = await call(listResearchColumns, ids.orgA, ids.userA1);
    expect(asTestRaw<{ items: unknown[] }>(listed).items).toHaveLength(HELD);

    // The gate the run endpoint puts every named column through.
    const named = await readNamedResearchColumns({
      tx: asTestRaw(testDb),
      columnIds,
      organizationId: ids.orgA,
    });
    expect(named).toHaveLength(HELD);
    expect(
      Value.Check(runResearchAnswersBodySchema, {
        columnIds,
        decisionIds: [decisionId],
      }),
    ).toBe(true);
    const claim = await testDb.transaction(
      async (tx) =>
        await queueResearchAnswerCells({
          tx: asTestRaw(tx),
          organizationId: ids.orgA,
          columnIds,
          decisionIds: [decisionId],
          force: false,
          now: new Date(),
        }),
    );
    expect(claim.cells).toHaveLength(HELD);

    const looked = await call(lookupResearchAnswers, ids.orgA, ids.userA1, {
      body: { decisionIds: [decisionId] },
    });
    expect(asTestRaw<{ items: unknown[] }>(looked).items).toHaveLength(HELD);

    const reordered = await call(reorderResearchColumns, ids.orgA, ids.userA1, {
      body: { columnIds: [...columnIds].toReversed() },
    });
    expect(statusOf(reordered)).toBeNull();
    const { columns } = asTestRaw<{ columns: { id: string }[] }>(reordered);
    expect(columns).toHaveLength(HELD);
    // The order the request named, not the order the rows were created in.
    expect(columns.at(0)?.id).toBe(columnIds.at(-1));
  });

  test("one more column is still refused", async () => {
    await holdColumns();

    const refused = await call(createResearchColumn, ids.orgA, ids.userA1, {
      body: { question: "One too many", answerType: "text" },
    });
    expect(statusOf(refused)).toBe(400);

    const stored = await testDb
      .select({ id: caseLawResearchColumns.id })
      .from(caseLawResearchColumns)
      .where(eq(caseLawResearchColumns.organizationId, ids.orgA));
    expect(stored).toHaveLength(HELD);
  });
});

describe("a run answers only the cells that need it", () => {
  const decisionOne = createSafeId<"caseLawDecision">();
  const decisionTwo = createSafeId<"caseLawDecision">();

  const queue = async (
    columnId: SafeId<"caseLawResearchColumn">,
    force: boolean,
    now: Date,
  ): Promise<ResearchAnswerClaim> =>
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

    expect((await queue(columnId, false, new Date())).cells).toHaveLength(1);
    const [kept] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionOne));
    expect(kept?.state).toBe("answered");
    expect(kept?.updatedAt).toEqual(answeredAt);

    // The second decision is pending from the run above, so only the answered
    // cell is re-queued.
    expect((await queue(columnId, true, new Date())).cells).toHaveLength(1);
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

    const claim = await queue(columnId, false, now);
    // Only the stale cell is claimed, and the run is handed that cell alone
    // rather than the whole column-by-decision rectangle.
    expect(claim.cells).toEqual([{ columnId, decisionId: decisionTwo }]);
    const [untouched] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionOne));
    expect(untouched?.updatedAt).toEqual(live);
    expect(untouched?.claimId).toBeNull();
    const [claimed] = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.decisionId, decisionTwo));
    expect(claimed?.updatedAt).toEqual(now);
    expect(claimed?.claimId).toBe(claim.claimId);
  });

  test("a run that lost its claim writes nothing", async () => {
    const columnId = await addColumn(ids.orgA, ids.userA1, "Stale claim?");
    const firstQueuedAt = new Date("2026-09-01T12:00:00.000Z");
    const reclaimedAt = new Date(
      firstQueuedAt.getTime() + LIMITS.caseLawResearchPendingStaleMs + 1000,
    );
    const stalled = await queue(columnId, false, firstQueuedAt);
    // The stalled run's cells age past the stale window and a newer run
    // reclaims them under its own id.
    const newer = await queue(columnId, false, reclaimedAt);
    expect(newer.cells).toHaveLength(stalled.cells.length);

    const deps = {
      safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
      // Nothing in the corpus answers these ids, so every cell this run does
      // own ends `failed`; that is the write the claim has to gate.
      caseLawDb: async (fn: (tx: unknown) => Promise<unknown>) =>
        await testDb.transaction(async (tx) => await fn(tx)),
    };
    const columns = [
      { columnId, question: "Stale claim?", answerType: "yes_no" as const },
    ];

    await runResearchAnswers(
      asTestRaw({
        organizationId: ids.orgA,
        userId: ids.userA1,
        columns,
        claim: stalled,
        orgAIConfig: null,
        promptCachingEnabled: false,
      }),
      asTestRaw(deps),
    );
    const afterStalled = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.columnId, columnId));
    expect(afterStalled.every((cell) => cell.state === "pending")).toBe(true);
    expect(afterStalled.every((cell) => cell.claimId === newer.claimId)).toBe(
      true,
    );

    // The run that does hold the claim writes, so the no-op above is the
    // claim check rather than the write path being broken.
    await runResearchAnswers(
      asTestRaw({
        organizationId: ids.orgA,
        userId: ids.userA1,
        columns,
        claim: newer,
        orgAIConfig: null,
        promptCachingEnabled: false,
      }),
      asTestRaw(deps),
    );
    const afterNewer = await testDb
      .select()
      .from(caseLawResearchAnswers)
      .where(eq(caseLawResearchAnswers.columnId, columnId));
    expect(afterNewer.every((cell) => cell.state === "failed")).toBe(true);
    expect(afterNewer.every((cell) => cell.claimId === null)).toBe(true);
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
