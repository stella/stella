import { inArray, sql } from "drizzle-orm";

import { caseLawCoverageSlices } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  ADAPTER_KEYS,
  type AdapterKey,
  CASE_LAW_SOURCE_ROWS_BOUND,
} from "@/api/lib/legal-search/ingestion-constants";

type CaseLawCoverageYear =
  | { year: number; type: "complete" }
  | { year: number; type: "gaps"; missing: number; shortSlices: number }
  | {
      year: number;
      type: "unlisted";
      missing: number;
      shortSlices: number;
      unlistedSlices: number;
    };

export type CaseLawKnownGaps =
  | {
      type: "reconciled";
      summary: {
        missing: number;
        shortSlices: number;
        unlistedSlices: number;
      };
      years: readonly CaseLawCoverageYear[];
    }
  | { type: "not_reconciled"; reason: string };

const YEAR_PREFIX_SLICE = { type: "year-prefix" } as const;
const NOT_DATE_SLICED = {
  type: "not-reconciled",
  reason: "The source listing is not partitioned into calendar-date slices.",
} as const;

/**
 * The grammar that turns each adapter's durable slice key into a calendar
 * year. This is total so a newly registered adapter cannot have slices
 * silently omitted from public completeness reporting.
 */
const COVERAGE_SLICE_GRAMMAR = {
  [ADAPTER_KEYS.CZ_REGIONAL]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.CZ_NS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.CZ_NSS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.CZ_US]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.CZ_UOHS]: NOT_DATE_SLICED,
  [ADAPTER_KEYS.SK_COURTS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.SK_US]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_COURTS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_SN]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_KIO]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_TK]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_NSA]: NOT_DATE_SLICED,
  [ADAPTER_KEYS.PL_NCOURT]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_COURTS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_VFGH]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_VWGH]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_BVWG]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_LVWG]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_ASYLGH]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_UBAS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_UVS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_VERG]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_UMSE]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_BKS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.AT_FINDOK]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.EU_ECJ]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.HU_BHGY]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_KIS]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_UODO]: YEAR_PREFIX_SLICE,
  [ADAPTER_KEYS.PL_UOKIK]: YEAR_PREFIX_SLICE,
} as const satisfies Record<
  AdapterKey,
  | typeof YEAR_PREFIX_SLICE
  | { readonly type: "not-reconciled"; readonly reason: string }
>;

const COVERAGE_SLICE_GRAMMAR_BY_KEY: ReadonlyMap<
  string,
  | typeof YEAR_PREFIX_SLICE
  | { readonly type: "not-reconciled"; readonly reason: string }
> = new Map(Object.entries(COVERAGE_SLICE_GRAMMAR));

/** Four decimal digits are the entire declared year key space. */
export const CASE_LAW_COVERAGE_YEARS_PER_SOURCE_BOUND = 10_000;
const COVERAGE_YEAR_ROWS_BOUND =
  CASE_LAW_SOURCE_ROWS_BOUND * CASE_LAW_COVERAGE_YEARS_PER_SOURCE_BOUND;

type CoverageYearAggregate = {
  year: number;
  missing: number;
  shortSlices: number;
  unlistedSlices: number;
};

export const summarizeCaseLawCoverageYears = (
  rows: readonly CoverageYearAggregate[],
): Extract<CaseLawKnownGaps, { type: "reconciled" }> => {
  let missing = 0;
  let shortSlices = 0;
  let unlistedSlices = 0;
  const years: CaseLawCoverageYear[] = [];

  for (const row of rows) {
    missing += row.missing;
    shortSlices += row.shortSlices;
    unlistedSlices += row.unlistedSlices;
    // A slice with no reported count is one whose listing walk failed (the
    // ledger's counted-or-failed check). Why it failed is operator state:
    // the walk error text never leaves the ledger.
    if (row.unlistedSlices > 0) {
      years.push({
        year: row.year,
        type: "unlisted",
        missing: row.missing,
        shortSlices: row.shortSlices,
        unlistedSlices: row.unlistedSlices,
      });
      continue;
    }
    if (row.missing > 0) {
      years.push({
        year: row.year,
        type: "gaps",
        missing: row.missing,
        shortSlices: row.shortSlices,
      });
      continue;
    }
    years.push({ year: row.year, type: "complete" });
  }

  return {
    type: "reconciled",
    summary: { missing, shortSlices, unlistedSlices },
    years,
  };
};

type CoverageSource = {
  id: SafeId<"caseLawSource">;
  adapterKey: string;
};

/** One grouped, bounded ledger read for all requested sources. */
export const readCaseLawCoverageYearsQuery = async (
  tx: CaseLawPublicReadTransaction,
  sources: readonly CoverageSource[],
): Promise<ReadonlyMap<string, CaseLawKnownGaps>> => {
  const result = new Map<string, CaseLawKnownGaps>();
  const reconciledSourceIds: SafeId<"caseLawSource">[] = [];

  for (const source of sources) {
    const grammar = COVERAGE_SLICE_GRAMMAR_BY_KEY.get(source.adapterKey);
    if (grammar === undefined) {
      result.set(String(source.id), {
        type: "not_reconciled",
        reason: "The source adapter has no declared slice grammar.",
      });
      continue;
    }
    if (grammar.type === "not-reconciled") {
      result.set(String(source.id), {
        type: "not_reconciled",
        reason: grammar.reason,
      });
      continue;
    }
    reconciledSourceIds.push(source.id);
  }

  if (reconciledSourceIds.length === 0) {
    return result;
  }

  const sliceYear = sql<number | null>`CASE
    WHEN ${caseLawCoverageSlices.slice} ~ '^[0-9]{4}($|[-])'
      THEN left(${caseLawCoverageSlices.slice}, 4)::integer
    ELSE NULL
  END`;
  const read = await readBounded(
    tx
      .select({
        sourceId: caseLawCoverageSlices.sourceId,
        year: sliceYear,
        missing: sql<number>`coalesce(sum(greatest(${caseLawCoverageSlices.reported} - ${caseLawCoverageSlices.collected}, 0)), 0)::integer`,
        shortSlices: sql<number>`count(*) FILTER (WHERE ${caseLawCoverageSlices.collected} < ${caseLawCoverageSlices.reported})::integer`,
        unlistedSlices: sql<number>`count(*) FILTER (WHERE ${caseLawCoverageSlices.reported} IS NULL)::integer`,
      })
      .from(caseLawCoverageSlices)
      .where(inArray(caseLawCoverageSlices.sourceId, reconciledSourceIds))
      .groupBy(caseLawCoverageSlices.sourceId, sliceYear)
      .orderBy(caseLawCoverageSlices.sourceId, sliceYear),
    COVERAGE_YEAR_ROWS_BOUND,
  );
  if (read.type === "overflow") {
    // A truncated ledger cannot be summarized: no source claims a count.
    for (const sourceId of reconciledSourceIds) {
      result.set(String(sourceId), {
        type: "not_reconciled",
        reason: "The slice ledger exceeds the coverage read bound.",
      });
    }
    return result;
  }
  const rows = read.rows;
  const bySource = new Map<string, CoverageYearAggregate[]>();
  for (const row of rows) {
    if (row.year === null) {
      result.set(row.sourceId, {
        type: "not_reconciled",
        reason:
          "A recorded slice does not match the adapter's declared grammar.",
      });
      continue;
    }
    const aggregate = {
      year: row.year,
      missing: row.missing,
      shortSlices: row.shortSlices,
      unlistedSlices: row.unlistedSlices,
    };
    const aggregates = bySource.get(row.sourceId);
    if (aggregates === undefined) {
      bySource.set(row.sourceId, [aggregate]);
      continue;
    }
    aggregates.push(aggregate);
  }
  for (const sourceId of reconciledSourceIds) {
    if (result.has(String(sourceId))) {
      continue;
    }
    const aggregates = bySource.get(String(sourceId));
    result.set(
      String(sourceId),
      aggregates === undefined
        ? {
            type: "not_reconciled",
            reason: "The source has not recorded any coverage slices.",
          }
        : summarizeCaseLawCoverageYears(aggregates),
    );
  }
  return result;
};
