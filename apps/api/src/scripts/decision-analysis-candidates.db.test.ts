/**
 * The candidate ranking's keyset paging against a real database.
 *
 * The cursor predicate and the ORDER BY are two encodings of one ordering;
 * when they disagree inside a tie the next page re-serves rows already
 * printed and skips the rest, which no mocked store can show. Heavy ties on
 * (authority, count) and pages of one to four rows put page boundaries
 * inside ties.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { listCandidateRows } from "./decision-analysis.db";
import type { CandidateCursor, CandidateRow } from "./decision-analysis.db";

/**
 * Fixture counts sit far above anything another suite stores, so the
 * `minCitations` floor alone keeps the walk to this run's rows.
 */
const COUNT_BASE = 1_000_000_000;
const MIN_CITATIONS = COUNT_BASE + 1;

const fixtureRow = fc.record({
  // Few distinct values, so most rows tie with a neighbour on the key.
  // Zero is what an uncited or not-yet-swept row stores, the realistic
  // long tie.
  citationAuthority: fc.constantFrom(0, 0, 0.25, 1.5, 3),
  citationCount: fc.constantFrom(
    COUNT_BASE,
    COUNT_BASE + 1,
    COUNT_BASE + 1,
    COUNT_BASE + 2,
  ),
  redacted: fc.constantFrom(false, false, false, true),
});

/** Ranking order: authority descending, then count descending. */
const rankedBefore = (left: CandidateRow, right: CandidateRow): boolean =>
  left.citationAuthority === right.citationAuthority
    ? left.citationCount >= right.citationCount
    : left.citationAuthority > right.citationAuthority;

const cursorOf = (row: CandidateRow): CandidateCursor => ({
  citationAuthority: row.citationAuthority,
  citationCount: row.citationCount,
  id: row.id,
});

type WalkOptions = { tx: TestDatabaseTransaction; scan: number };

/** The script's own loop: resume after each page's last row until empty. */
const walkAllPages = async ({
  tx,
  scan,
}: WalkOptions): Promise<CandidateRow[]> => {
  const served: CandidateRow[] = [];
  let after: CandidateCursor | undefined;
  // A broken predicate can re-serve rows forever; bound the walk well past
  // any correct one so the assertion, not the timeout, reports it.
  for (let page = 0; page < 200; page += 1) {
    // db-await-in-loop: keyset paging is the behaviour under test
    const rows = await listCandidateRows(tx, {
      after,
      minCitations: MIN_CITATIONS,
      scan,
    });
    const last = rows.at(-1);
    if (last === undefined) {
      return served;
    }
    served.push(...rows);
    after = cursorOf(last);
  }
  return served;
};

describe("analysis candidate paging", () => {
  let db: TestDatabase;
  let sourceId: SafeId<"caseLawSource">;
  let counter = 0;

  beforeAll(async () => {
    db = await getTestDb();
    const [source] = await db
      .insert(caseLawSources)
      .values({
        name: `analysis-candidates-${Bun.randomUUIDv7().slice(0, 8)}`,
        adapterKey: ADAPTER_KEYS.CZ_NS,
      })
      .returning({ id: caseLawSources.id });
    if (!source) {
      throw new Error("expected a case-law source row");
    }
    sourceId = source.id;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  test("analysis-candidates-keyset-paging-serves-each-eligible-row-once-in-rank-order", async () => {
    await assertProperty(
      "analysis-candidates-keyset-paging-serves-each-eligible-row-once-in-rank-order",
      fc.asyncProperty(
        fc.array(fixtureRow, { minLength: 1, maxLength: 24 }),
        fc.integer({ min: 1, max: 4 }),
        async (fixtures, scan) => {
          await db
            .transaction(async (tx) => {
              const inserted = await tx
                .insert(caseLawDecisions)
                .values(
                  fixtures.map((fixture) => {
                    counter += 1;
                    return {
                      sourceId,
                      caseNumber: `Cdo ${String(counter)}/2026`,
                      court: "Nejvyšší soud",
                      country: "CZE",
                      language: "cs",
                      citationAuthority: fixture.citationAuthority,
                      citationCount: fixture.citationCount,
                      redactedAt: fixture.redacted ? new Date() : null,
                    };
                  }),
                )
                .returning({
                  id: caseLawDecisions.id,
                  citationCount: caseLawDecisions.citationCount,
                  redactedAt: caseLawDecisions.redactedAt,
                });
              const eligible = inserted
                .filter(
                  (row) =>
                    row.redactedAt === null &&
                    row.citationCount >= MIN_CITATIONS,
                )
                .map((row) => row.id);

              const served = await walkAllPages({ tx, scan });
              const servedIds = served.map((row) => row.id);

              // Exactly once: no repeats, and nothing eligible left behind.
              expect(new Set(servedIds).size).toBe(servedIds.length);
              expect(servedIds.toSorted()).toEqual(eligible.toSorted());
              // In order: the pages concatenate to the one-page ranking.
              const onePage = await listCandidateRows(tx, {
                minCitations: MIN_CITATIONS,
                scan: fixtures.length + 1,
              });
              expect(servedIds).toEqual(onePage.map((row) => row.id));
              for (const [index, row] of served.entries()) {
                const next = served.at(index + 1);
                if (next !== undefined) {
                  expect(rankedBefore(row, next)).toBe(true);
                }
              }
              tx.rollback();
            })
            .catch((error: unknown) => {
              if (!(error instanceof TransactionRollbackError)) {
                throw error;
              }
            });
        },
      ),
      { numRuns: 60 },
    );
  });
});
