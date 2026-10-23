import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisionIdentifierBackfills,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { resolveCitationBatch } from "@/api/handlers/case-law/citation-resolution";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import {
  DECISION_IDENTIFIER_BACKFILL_VERSION,
  DECISION_IDENTIFIER_RECONCILIATION_COOLDOWN_MS,
  DECISION_IDENTIFIER_RECONCILIATION_GRACE_MS,
  reconcileDecisionIdentifiersStep,
} from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural test adapter across Drizzle drivers
const rootDb = () => db as unknown as CaseLawRootHandle;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural test adapter across Drizzle drivers
const scopedDb = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await fn(db as unknown as Transaction);

const COURT = "Ústavní soud";
const CITED_ECLI = "ECLI:CZ:US:2025:Pl.US.32.25.1";
const PASS_STEP_LIMIT = 50;
const sourceId = createSafeId<"caseLawSource">();
const citingId = createSafeId<"caseLawDecision">();
const citedId = createSafeId<"caseLawDecision">();
const citationId = createSafeId<"caseLawCitation">();
const startedAt = new Date("2026-10-22T12:00:00.000Z");

const base = {
  sourceId,
  court: COURT,
  country: "CZE",
  language: "cs",
  fulltext: "text",
  decisionDate: "2025-06-01",
};

/** Steps until the pass completes; each later pass starts after the cooldown. */
const completePass = async (now: Date) => {
  for (let step = 0; step < PASS_STEP_LIMIT; step += 1) {
    // db-await-in-loop: one checkpoint page per step, bounded by PASS_STEP_LIMIT
    const result = await reconcileDecisionIdentifiersStep(rootDb(), {
      now,
      batchSize: 10,
    });
    if (result.status === "completed") {
      return;
    }
  }
  throw new Error("The reconciliation pass did not complete");
};

/** The next pass may start once the cooldown after the stored completion ends. */
const afterCooldown = async () => {
  const completedAt = (
    await db
      .select({ completedAt: caseLawDecisionIdentifierBackfills.completedAt })
      .from(caseLawDecisionIdentifierBackfills)
      .where(
        eq(
          caseLawDecisionIdentifierBackfills.version,
          DECISION_IDENTIFIER_BACKFILL_VERSION,
        ),
      )
  ).at(0)?.completedAt;
  if (!(completedAt instanceof Date)) {
    throw new TypeError("Expected a completed reconciliation pass");
  }
  return new Date(
    completedAt.getTime() + DECISION_IDENTIFIER_RECONCILIATION_COOLDOWN_MS,
  );
};

const lastCompletedRepairs = async () =>
  (
    await db
      .select({
        repairs:
          caseLawDecisionIdentifierBackfills.lastCompletedRepairedByCourt,
      })
      .from(caseLawDecisionIdentifierBackfills)
      .where(
        eq(
          caseLawDecisionIdentifierBackfills.version,
          DECISION_IDENTIFIER_BACKFILL_VERSION,
        ),
      )
  ).at(0)?.repairs;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `identifier-reconciliation-${Bun.randomUUIDv7().slice(0, 16)}`,
    name: "Decision identifier reconciliation test",
  });
  // Rows written two days before the pass: past the grace window, so the
  // missing identifiers count as an invariant break, not ingestion in flight.
  const createdAt = new Date(startedAt.getTime() - 2 * 24 * 60 * 60 * 1000);
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: citingId,
      caseNumber: "III. ÚS 1/26",
      slug: "citing",
      languageGroupKey: "citing",
      createdAt,
    },
    {
      ...base,
      id: citedId,
      caseNumber: "Pl. ÚS 32/25",
      ecli: CITED_ECLI,
      slug: "cited",
      languageGroupKey: "cited",
      createdAt,
    },
  ]);
  await db.insert(caseLawCitations).values({
    id: citationId,
    citingDecisionId: citingId,
    citationText: CITED_ECLI,
    citationKey: CITED_ECLI.toLowerCase(),
    resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED,
    resolutionAttemptedAt: new Date("2026-08-24T10:00:00.000Z"),
  });
});

afterAll(async () => {
  await client.close();
});

test("a decision without identifier rows gets them on the next pass, and its ECLI citation then resolves", async () => {
  expect(
    await db
      .select()
      .from(caseLawDecisionIdentifiers)
      .where(eq(caseLawDecisionIdentifiers.decisionId, citedId)),
  ).toEqual([]);

  await completePass(startedAt);

  expect(
    await db
      .select({ value: caseLawDecisionIdentifiers.value })
      .from(caseLawDecisionIdentifiers)
      .where(
        and(
          eq(caseLawDecisionIdentifiers.decisionId, citedId),
          eq(caseLawDecisionIdentifiers.type, DECISION_IDENTIFIER_TYPES.ECLI),
        ),
      ),
  ).toEqual([{ value: CITED_ECLI }]);
  // Both decisions lacked their rows and are older than the grace window.
  expect(await lastCompletedRepairs()).toEqual({ [COURT]: 2 });

  await resolveCitationBatch(scopedDb, { limit: 100, after: null });
  expect(
    await db
      .select({
        status: caseLawCitations.resolutionStatus,
        cited: caseLawCitations.citedDecisionId,
      })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.id, citationId)),
  ).toEqual([{ status: CITATION_RESOLUTION_STATUS.RESOLVED, cited: citedId }]);
});

test("a pass over complete rows reports zero for every court it scanned", async () => {
  await completePass(await afterCooldown());
  expect(await lastCompletedRepairs()).toEqual({ [COURT]: 0 });
});

test("decisions inside the grace window are repaired but not reported", async () => {
  const recentId = createSafeId<"caseLawDecision">();
  const thirdPass = await afterCooldown();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: recentId,
    caseNumber: "IV. ÚS 2/26",
    ecli: "ECLI:CZ:US:2026:4.US.2.26.1",
    slug: "recent",
    languageGroupKey: "recent",
    createdAt: new Date(
      thirdPass.getTime() - DECISION_IDENTIFIER_RECONCILIATION_GRACE_MS / 2,
    ),
  });

  await completePass(thirdPass);

  expect(
    await db
      .select({ type: caseLawDecisionIdentifiers.type })
      .from(caseLawDecisionIdentifiers)
      .where(
        and(
          eq(caseLawDecisionIdentifiers.decisionId, recentId),
          eq(caseLawDecisionIdentifiers.type, DECISION_IDENTIFIER_TYPES.ECLI),
        ),
      ),
  ).toEqual([{ type: DECISION_IDENTIFIER_TYPES.ECLI }]);
  expect(await lastCompletedRepairs()).toEqual({ [COURT]: 0 });
});
