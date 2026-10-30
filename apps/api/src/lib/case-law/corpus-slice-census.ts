import { and, gte, inArray, lte, or, sql } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import type {
  CorpusSliceManifest,
  CorpusSliceYear,
} from "@/api/lib/case-law/corpus-slice";
import { CORPUS_SLICE_CONFIG } from "@/api/lib/case-law/corpus-slice";

type CorpusSliceCensusCell =
  | {
      type: "complete";
      sourceKey: string;
      court: string;
      year: CorpusSliceYear;
    }
  | {
      type: "missing";
      sourceKey: string;
      court: string;
      year: CorpusSliceYear;
      expected: number;
      held: number;
    }
  | {
      type: "extra";
      sourceKey: string;
      court: string;
      year: CorpusSliceYear;
      held: number;
    };

type CorpusSliceCensus =
  | { verdict: "complete"; cells: CorpusSliceCensusCell[] }
  | { verdict: "incomplete"; cells: CorpusSliceCensusCell[] }
  | { verdict: "membership_mismatch"; cells: CorpusSliceCensusCell[] };

type CorpusSliceCensusTransaction = Pick<
  CaseLawPublicReadTransaction,
  "select"
>;

type CorpusSliceCensusDb = <T>(
  read: (tx: CorpusSliceCensusTransaction) => Promise<T>,
) => Promise<T>;

type HeldCell = {
  id: string;
  sourceKey: string;
  court: string;
  decisionDate: string | null;
};

const keyOf = (sourceKey: string, court: string, year: CorpusSliceYear) =>
  JSON.stringify([
    sourceKey,
    court,
    year.type === "year" ? String(year.year) : year.type,
  ]);

const yearOf = (decisionDate: string | null): CorpusSliceYear =>
  decisionDate === null
    ? { type: "undated" }
    : { type: "year", year: Number.parseInt(decisionDate.slice(0, 4), 10) };

export const corpusSliceCensus = async (
  manifest: CorpusSliceManifest,
  caseLawDb: CorpusSliceCensusDb,
): Promise<CorpusSliceCensus> => {
  const asOf = Temporal.Instant.from(manifest.asOf)
    .toZonedDateTimeISO("UTC")
    .toPlainDate();
  const firstYear = asOf.year - manifest.recentYears + 1;
  const heldRows = await caseLawDb(
    async (tx) =>
      await tx
        .select({
          id: publishedCaseLawDecisions.id,
          sourceKey: caseLawSources.adapterKey,
          court: publishedCaseLawDecisions.court,
          decisionDate: publishedCaseLawDecisions.decisionDate,
        })
        .from(publishedCaseLawDecisions)
        .innerJoin(
          caseLawSources,
          sql`${caseLawSources.id} = ${publishedCaseLawDecisions.sourceId}`,
        )
        .where(
          or(
            and(
              gte(
                publishedCaseLawDecisions.decisionDate,
                `${String(firstYear)}-01-01`,
              ),
              lte(publishedCaseLawDecisions.decisionDate, asOf.toString()),
            ),
            CORPUS_SLICE_CONFIG.pinnedDecisionIds.length === 0
              ? undefined
              : inArray(
                  publishedCaseLawDecisions.id,
                  CORPUS_SLICE_CONFIG.pinnedDecisionIds,
                ),
          ),
        ),
  );
  const held = new Map<
    string,
    { row: HeldCell; year: CorpusSliceYear; count: number }
  >();
  for (const row of heldRows) {
    const year = yearOf(row.decisionDate);
    const key = keyOf(row.sourceKey, row.court, year);
    const existing = held.get(key);
    if (existing === undefined) {
      held.set(key, { row, year, count: 1 });
    } else {
      existing.count += 1;
    }
  }

  const cells: CorpusSliceCensusCell[] = [];
  for (const expected of manifest.cells) {
    const key = keyOf(expected.sourceKey, expected.court, expected.year);
    const found = held.get(key)?.count ?? 0;
    held.delete(key);
    if (found === expected.count) {
      cells.push({
        type: "complete",
        sourceKey: expected.sourceKey,
        court: expected.court,
        year: expected.year,
      });
    } else if (found < expected.count) {
      cells.push({
        type: "missing",
        sourceKey: expected.sourceKey,
        court: expected.court,
        year: expected.year,
        expected: expected.count,
        held: found,
      });
    } else {
      cells.push({
        type: "extra",
        sourceKey: expected.sourceKey,
        court: expected.court,
        year: expected.year,
        held: found,
      });
    }
  }
  for (const { row, year, count } of held.values()) {
    cells.push({
      type: "extra",
      sourceKey: row.sourceKey,
      court: row.court,
      year,
      held: count,
    });
  }
  cells.sort((left, right) => {
    const leftKey = keyOf(left.sourceKey, left.court, left.year);
    const rightKey = keyOf(right.sourceKey, right.court, right.year);
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
  if (!cells.every(({ type }) => type === "complete")) {
    return { verdict: "incomplete", cells };
  }
  const heldMemberIdsSha256 = sha256Hex(
    heldRows
      .map(({ id }) => id)
      .toSorted()
      .join("\n"),
  );
  if (
    heldRows.length !== manifest.memberCount ||
    heldMemberIdsSha256 !== manifest.memberIdsSha256
  ) {
    return { verdict: "membership_mismatch", cells };
  }
  return { verdict: "complete", cells };
};
