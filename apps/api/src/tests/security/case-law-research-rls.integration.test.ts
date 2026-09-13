import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
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
const orgAColumnId = createSafeId<"caseLawResearchColumn">();
const orgBColumnId = createSafeId<"caseLawResearchColumn">();

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    await testDb.insert(caseLawResearchColumns).values([
      {
        id: orgAColumnId,
        organizationId: ids.orgA,
        position: 1,
        question: "Did the court uphold the lease?",
        content: {
          version: 1,
          type: "single-select",
          options: [
            { color: "green", value: "yes" },
            { color: "red", value: "no" },
          ],
          fallback: null,
        },
        tool: { version: 1, role: "fast" },
      },
      {
        id: orgBColumnId,
        organizationId: ids.orgB,
        position: 1,
        question: "Outcome?",
        content: { version: 1, type: "text" },
        tool: { version: 1, role: "fast" },
      },
    ]);
    await testDb.insert(caseLawResearchAnswers).values([
      {
        columnId: orgAColumnId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionA,
        state: "answered",
        answer: { version: 1, type: "single-select", value: "yes" },
        run: {
          version: 1,
          model: "test-model",
          completedAt: "2026-09-01T00:00:00.000Z",
          retrieved: false,
          rationale: "The court dismissed the appeal.",
          justification: { version: 1, blocks: [] },
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

describe("case-law research columns and answers RLS", () => {
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
        answer: { version: 1, type: "single-select", value: "no" },
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

  test("a cell cannot hold a value that is not field content", async () => {
    const scopedA = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    // Raw SQL on purpose: the typed insert cannot express the pre-property
    // shape, and the guard under test is the database's, not TypeScript's.
    const legacyShape: unknown = await scopedA((tx) =>
      tx.execute(sql`
        INSERT INTO case_law_research_answers
          (column_id, organization_id, decision_id, state, answer)
        VALUES (
          ${orgAColumnId}::uuid,
          ${ids.orgA},
          ${ids.caseLawDecisionB}::uuid,
          'answered',
          '{"type":"yes_no","value":"yes"}'::jsonb
        )
      `),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(legacyShape).toBeInstanceOf(Error);
  });
});
