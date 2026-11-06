import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;

const rootDb = () => asTestRaw<CaseLawRootHandle>(db);
const scopedDb = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await fn(asTestRaw<Transaction>(db));

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
  const diagnosticCourts: string[] = [];
  for (let step = 0; step < PASS_STEP_LIMIT; step += 1) {
    // db-await-in-loop: one checkpoint page per step, bounded by PASS_STEP_LIMIT
    const result = await reconcileDecisionIdentifiersStep(rootDb(), {
      now,
      batchSize: 10,
    });
    if (result.status === "advanced" && result.repairs !== undefined) {
      diagnosticCourts.push(...result.repairs.courts.map(({ court }) => court));
      expect(result.repairs.courts.length).toBeLessThanOrEqual(8);
    }
    if (result.status === "completed") {
      return diagnosticCourts;
    }
  }
  throw new Error("The reconciliation pass did not complete");
};

type RetryResult = Extract<
  Awaited<ReturnType<typeof reconcileDecisionIdentifiersStep>>,
  { status: "retry" | "retry-paused" }
>;

const advanceUntilRetry = async (now: Date, page = 0): Promise<RetryResult> => {
  if (page >= PASS_STEP_LIMIT) {
    throw new Error("The reconciliation pass did not reach verification retry");
  }
  const result = await reconcileDecisionIdentifiersStep(rootDb(), {
    now,
    batchSize: 10,
  });
  if (result.status === "retry" || result.status === "retry-paused") {
    return result;
  }
  expect(result.status).toBe("advanced");
  return await advanceUntilRetry(now, page + 1);
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
        repairs: caseLawDecisionIdentifierBackfills.lastCompletedRepairedCount,
      })
      .from(caseLawDecisionIdentifierBackfills)
      .where(
        eq(
          caseLawDecisionIdentifierBackfills.version,
          DECISION_IDENTIFIER_BACKFILL_VERSION,
        ),
      )
  ).at(0)?.repairs;

beforeEach(async () => {
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

afterEach(async () => {
  await client?.close();
  client = undefined;
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
  expect(await lastCompletedRepairs()).toBe(2);

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

test("a pass over complete rows reports zero repairs", async () => {
  await completePass(startedAt);
  expect(await lastCompletedRepairs()).toBe(2);
  await completePass(await afterCooldown());
  expect(await lastCompletedRepairs()).toBe(0);
});

test("decisions inside the grace window are repaired but not reported", async () => {
  const recentId = createSafeId<"caseLawDecision">();
  const agedId = createSafeId<"caseLawDecision">();
  await completePass(startedAt);
  expect(await lastCompletedRepairs()).toBe(2);
  const thirdPass = await afterCooldown();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: recentId,
      caseNumber: "IV. ÚS 2/26",
      ecli: "ECLI:CZ:US:2026:4.US.2.26.1",
      slug: "recent",
      languageGroupKey: "recent",
      createdAt: new Date(
        thirdPass.getTime() - DECISION_IDENTIFIER_RECONCILIATION_GRACE_MS / 2,
      ),
    },
    {
      ...base,
      id: agedId,
      court: "Ú".repeat(200),
      caseNumber: "V. ÚS 3/26",
      slug: "aged",
      languageGroupKey: "aged",
      createdAt: new Date(
        thirdPass.getTime() - 2 * DECISION_IDENTIFIER_RECONCILIATION_GRACE_MS,
      ),
    },
  ]);

  const diagnosticCourts = await completePass(thirdPass);

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
  expect(await lastCompletedRepairs()).toBe(1);
  expect(diagnosticCourts).toEqual(["Ú".repeat(48)]);
  expect(
    Buffer.byteLength(diagnosticCourts[0] ?? "", "utf-8"),
  ).toBeLessThanOrEqual(96);
});

test("verification retries preserve repairs and pause a poison row until bounded recovery", async () => {
  const poisonId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: poisonId,
    caseNumber: "   ",
    slug: "poisoned-reference",
    languageGroupKey: "poisoned-reference",
    createdAt: new Date(startedAt.getTime() - 2 * 24 * 60 * 60_000),
  });

  const first = await advanceUntilRetry(startedAt);
  expect(first).toMatchObject({ status: "retry", attempt: 1 });
  const second = await advanceUntilRetry(startedAt);
  expect(second).toMatchObject({ status: "retry", attempt: 2 });
  const third = await advanceUntilRetry(startedAt);
  expect(third).toMatchObject({ status: "retry-paused", attempt: 3 });
  const paused = await reconcileDecisionIdentifiersStep(rootDb(), {
    now: startedAt,
    batchSize: 10,
  });
  expect(paused.status).toBe("paused");
  if (paused.status !== "paused") {
    throw new TypeError("Expected a paused verification checkpoint");
  }
  const checkpoint = (
    await db
      .select({
        repairedCount: caseLawDecisionIdentifierBackfills.repairedCount,
      })
      .from(caseLawDecisionIdentifierBackfills)
      .where(
        eq(
          caseLawDecisionIdentifierBackfills.version,
          DECISION_IDENTIFIER_BACKFILL_VERSION,
        ),
      )
  ).at(0);
  expect(checkpoint?.repairedCount).toBe(2);

  await db
    .update(caseLawDecisions)
    .set({ caseNumber: "IV. ÚS 2/26" })
    .where(eq(caseLawDecisions.id, poisonId));
  await completePass(new Date(new Date(paused.retryAfter).getTime() + 1));
  expect(await lastCompletedRepairs()).toBe(3);
});
