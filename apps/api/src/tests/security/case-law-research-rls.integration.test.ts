import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { CaseLawResearchSavedQuery } from "@stll/api-contract";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
  caseLawResearchTableDecisions,
  caseLawResearchTables,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const orgATableId = createSafeId<"caseLawResearchTable">();
const orgBTableId = createSafeId<"caseLawResearchTable">();
const orgAColumnId = createSafeId<"caseLawResearchColumn">();
const orgBColumnId = createSafeId<"caseLawResearchColumn">();

const savedQuery = {
  version: 1,
  query: "nájemní smlouva",
  country: "CZE",
} satisfies CaseLawResearchSavedQuery;

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    await testDb.insert(caseLawResearchTables).values([
      {
        id: orgATableId,
        organizationId: ids.orgA,
        ownerUserId: ids.userA1,
        name: "Org A leases",
        savedQuery,
      },
      {
        id: orgBTableId,
        organizationId: ids.orgB,
        ownerUserId: ids.userB1,
        name: "Org B leases",
        savedQuery,
      },
    ]);
    await testDb.insert(caseLawResearchTableDecisions).values([
      {
        tableId: orgATableId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionA,
        disposition: "pinned",
        position: 1,
        addedBy: ids.userA1,
      },
      {
        tableId: orgBTableId,
        organizationId: ids.orgB,
        decisionId: ids.caseLawDecisionB,
        disposition: "excluded",
        position: 0,
        addedBy: ids.userB1,
      },
    ]);
    await testDb.insert(caseLawResearchColumns).values([
      {
        id: orgAColumnId,
        tableId: orgATableId,
        organizationId: ids.orgA,
        position: 1,
        question: "Did the court uphold the lease?",
        answerType: "yes_no",
        tool: { version: 1, role: "fast" },
      },
      {
        id: orgBColumnId,
        tableId: orgBTableId,
        organizationId: ids.orgB,
        position: 1,
        question: "Outcome?",
        answerType: "text",
        tool: { version: 1, role: "fast" },
      },
    ]);
    await testDb.insert(caseLawResearchAnswers).values([
      {
        columnId: orgAColumnId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionA,
        state: "answered",
        answer: { type: "yes_no", value: "yes" },
        confidence: 0.8,
        run: {
          version: 1,
          model: "test-model",
          completedAt: "2026-09-01T00:00:00.000Z",
          retrieved: false,
          rationale: "The court dismissed the appeal.",
          passages: [],
        },
      },
      {
        columnId: orgBColumnId,
        organizationId: ids.orgB,
        decisionId: ids.caseLawDecisionB,
        state: "pending",
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

describe("case-law research tables RLS", () => {
  test("a member sees every table of their organization and none of another's", async () => {
    // A2 did not create the table; organization-wide visibility is the v1 rule.
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA2);
    const tables = await scoped((tx) =>
      tx.select({ id: caseLawResearchTables.id }).from(caseLawResearchTables),
    );
    expect(tables).toEqual([{ id: orgATableId }]);

    const dispositions = await scoped((tx) =>
      tx
        .select({ tableId: caseLawResearchTableDecisions.tableId })
        .from(caseLawResearchTableDecisions),
    );
    expect(dispositions).toEqual([{ tableId: orgATableId }]);
  });

  test("another organization can neither update nor pin into the table", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgB, ids.userB1);
    const renamed = await scoped((tx) =>
      tx
        .update(caseLawResearchTables)
        .set({ name: "attempted cross-organization rename" })
        .where(eq(caseLawResearchTables.id, orgATableId))
        .returning({ id: caseLawResearchTables.id }),
    );
    expect(renamed).toEqual([]);

    // The child row names org A's table with org B's tenant column: the
    // composite foreign key refuses the pair even before RLS is consulted.
    const pinned: unknown = await scoped((tx) =>
      tx
        .insert(caseLawResearchTableDecisions)
        .values({
          tableId: orgATableId,
          organizationId: ids.orgB,
          decisionId: ids.caseLawDecisionB,
          disposition: "pinned",
          position: 1,
          addedBy: ids.userB1,
        })
        .returning({ tableId: caseLawResearchTableDecisions.tableId }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pinned).toBeInstanceOf(Error);
  });

  test("question columns and answers stay inside their organization", async () => {
    const scopedA = createScopedDb(testDb, [], ids.orgA, ids.userA2);
    const columns = await scopedA((tx) =>
      tx.select({ id: caseLawResearchColumns.id }).from(caseLawResearchColumns),
    );
    expect(columns).toEqual([{ id: orgAColumnId }]);
    const answers = await scopedA((tx) =>
      tx
        .select({ columnId: caseLawResearchAnswers.columnId })
        .from(caseLawResearchAnswers),
    );
    expect(answers).toEqual([{ columnId: orgAColumnId }]);

    // Org B cannot reword org A's question nor write into its cells.
    const scopedB = createScopedDb(testDb, [], ids.orgB, ids.userB1);
    const reworded = await scopedB((tx) =>
      tx
        .update(caseLawResearchColumns)
        .set({ question: "attempted cross-organization edit" })
        .where(eq(caseLawResearchColumns.id, orgAColumnId))
        .returning({ id: caseLawResearchColumns.id }),
    );
    expect(reworded).toEqual([]);
    const answered: unknown = await scopedB((tx) =>
      tx
        .insert(caseLawResearchAnswers)
        .values({
          columnId: orgAColumnId,
          organizationId: ids.orgB,
          decisionId: ids.caseLawDecisionB,
          state: "pending",
        })
        .returning({ columnId: caseLawResearchAnswers.columnId }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(answered).toBeInstanceOf(Error);
  });

  test("a cell holds an answer exactly when it is answered", async () => {
    const scopedA = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    const emptyAnswered: unknown = await scopedA((tx) =>
      tx.insert(caseLawResearchAnswers).values({
        columnId: orgAColumnId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionB,
        state: "answered",
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(emptyAnswered).toBeInstanceOf(Error);

    const pendingWithAnswer: unknown = await scopedA((tx) =>
      tx.insert(caseLawResearchAnswers).values({
        columnId: orgAColumnId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionB,
        state: "pending",
        answer: { type: "yes_no", value: "no" },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pendingWithAnswer).toBeInstanceOf(Error);

    // One cell per (column, decision): a second queue attempt is a conflict,
    // which the run handler resolves with an upsert rather than a duplicate.
    const duplicate: unknown = await scopedA((tx) =>
      tx.insert(caseLawResearchAnswers).values({
        columnId: orgAColumnId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionA,
        state: "pending",
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicate).toBeInstanceOf(Error);
  });
});
