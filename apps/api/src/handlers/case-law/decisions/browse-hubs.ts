import { Result } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  publicCaseLawPageCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { numberFromString } from "@stll/api-contract/http-input";
import { Temporal } from "@stll/time";

import { readAdmittedCourtPage } from "@/api/handlers/case-law/decisions/shelf-courts";
import { status } from "@/api/http/status";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";

/**
 * The crawlable browse tree of a jurisdiction's decisions: its courts, then a
 * court's years, months and, for a month too large for one listing, its days.
 * Every answer is a bounded read of the `(country, court, date)` index: a
 * loose index scan with one descent per period that holds a decision, and
 * per-period counts capped at one past what a listing can page through, so a
 * busy month costs what a quiet one does.
 */

export const listBrowseCourtsQuerySchema = v.object({
  country: tPublicLawCountry,
});

export const readBrowseCalendarQuerySchema = v.object({
  country: tPublicLawCountry,
  court: v.pipe(v.string(), v.maxLength(512)),
  year: v.optional(
    numberFromString(
      v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(9999)),
    ),
  ),
  month: v.optional(
    numberFromString(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)),
    ),
  ),
});

type ReadBrowseCalendarQuery = v.InferOutput<
  typeof readBrowseCalendarQuerySchema
>;

/** A period that holds at least one decision, with its capped count. */
export type BrowseCalendarPeriod = {
  value: number;
  /** Decisions in the period, counted up to `caseLawBrowseListingDepth + 1`. */
  count: number;
};

export type BrowseCalendar = {
  level: "years" | "months" | "days";
  periods: BrowseCalendarPeriod[];
  /**
   * Decisions the court holds without a date, counted up to the same cap
   * (years level only; zero below it).
   */
  undated: number;
};

const admittedCountry = (country: string) => {
  const countryRead = readPublicLawCountry(country, {
    domain: "caseLaw",
    admitted: PUBLIC_CASE_LAW_PAGE_COUNTRIES,
    surface: "pages",
  });
  if (countryRead.kind === "unavailable") {
    return { kind: "answer", answer: countryRead.answer } as const;
  }
  if (countryRead.kind === "unreadable") {
    return {
      kind: "answer",
      answer: status(400, { message: countryRead.message }),
    } as const;
  }
  const publicCountry = publicCaseLawPageCountry(countryRead.country);
  if (publicCountry === null) {
    return {
      kind: "answer",
      answer: status(404, { message: "Not Found" }),
    } as const;
  }
  return { kind: "country", country: publicCountry } as const;
};

/**
 * Every court of the jurisdiction a public surface may name, by stored name:
 * one keyset page of the folded population counts, at most
 * `caseLawBrowseCourtsMax` courts. `truncated` says the cap cut the list.
 */
export const listBrowseCourtsHandler = async (
  query: v.InferOutput<typeof listBrowseCourtsQuerySchema>,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const admitted = admittedCountry(query.country);
  if (admitted.kind === "answer") {
    return admitted.answer;
  }
  const excluded = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excluded)) {
    // Fail closed: naming courts without the source policy could name one
    // whose every source is withheld.
    return await Promise.reject(excluded.error);
  }
  const page = await readAdmittedCourtPage({
    caseLawDb,
    country: admitted.country,
    excludedSourceIds: excluded.value,
    after: null,
    limit: LIMITS.caseLawBrowseCourtsMax,
  });
  return {
    courts: page.courts,
    truncated: page.more,
  };
};

const COUNT_CAP = LIMITS.caseLawBrowseListingDepth + 1;

/**
 * A row counts only when its source may be redistributed, as the listing
 * the calendar links to applies: a withheld source's periods are never
 * named or counted.
 */
const servable = (alias: string) =>
  sql`EXISTS (SELECT 1 FROM case_law_sources AS servable_source WHERE servable_source.id = ${sql.identifier(alias)}.source_id AND ${redistributableCaseLawSourceFor(sql`servable_source.descriptor`)})`;

/**
 * The years a court holds decisions in: one index descent per year, from the
 * court's first dated decision to its last, never a walk of its rows.
 */
const courtYearsStatement = (country: string, court: string) => sql`
  WITH RECURSIVE year_walk AS (
    SELECT min(coalesce(first_decision.decision_date, '-infinity'::date)) AS day
    FROM case_law_published_decisions first_decision
    WHERE first_decision.country = ${country}
      AND first_decision.court = ${court}
      AND ${servable("first_decision")}
      AND coalesce(first_decision.decision_date, '-infinity'::date) > '-infinity'::date
    UNION ALL
    SELECT (
      SELECT min(coalesce(next_decision.decision_date, '-infinity'::date))
      FROM case_law_published_decisions next_decision
      WHERE next_decision.country = ${country}
        AND next_decision.court = ${court}
        AND ${servable("next_decision")}
        AND coalesce(next_decision.decision_date, '-infinity'::date)
          >= make_date(extract(year FROM year_walk.day)::int + 1, 1, 1)
    )
    FROM year_walk
    WHERE year_walk.day IS NOT NULL
  )
  SELECT extract(year FROM year_walk.day)::int AS value, 0 AS count
  FROM year_walk
  WHERE year_walk.day IS NOT NULL
  UNION ALL
  SELECT -1 AS value, count(*)::int AS count
  FROM (
    SELECT 1
    FROM case_law_published_decisions undated_decision
    WHERE undated_decision.country = ${country}
      AND undated_decision.court = ${court}
      AND ${servable("undated_decision")}
      AND coalesce(undated_decision.decision_date, '-infinity'::date) = '-infinity'::date
    LIMIT ${COUNT_CAP}
  ) AS undated
`;

type PeriodRange = {
  /** First day of the enclosing period, ISO. */
  start: string;
  /** Number of sub-periods (months of a year, days of a month). */
  parts: number;
  unit: "month" | "day";
};

/**
 * Each sub-period of a year or month with its decisions counted up to the
 * cap: a lateral, limited index range per sub-period.
 */
// Bounds are cast back to `date`: compared as timestamps, the indexed
// `coalesce(decision_date, ...)` expression would not match the index.
const periodCountsStatement = (
  country: string,
  court: string,
  { start, parts, unit }: PeriodRange,
) => {
  const step =
    unit === "month" ? sql`interval '1 month'` : sql`interval '1 day'`;
  return sql`
  SELECT part.value, capped.count
  FROM generate_series(1, ${parts}::int) AS part(value)
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS count
    FROM (
      SELECT 1
      FROM case_law_published_decisions decision
      WHERE decision.country = ${country}
        AND decision.court = ${court}
        AND ${servable("decision")}
        AND coalesce(decision.decision_date, '-infinity'::date)
          >= (${start}::date + (part.value - 1) * ${step})::date
        AND coalesce(decision.decision_date, '-infinity'::date)
          < (${start}::date + part.value * ${step})::date
      LIMIT ${COUNT_CAP}
    ) AS rows_in_part
  ) AS capped
  WHERE capped.count > 0
  ORDER BY part.value
`;
};

const daysInMonth = (year: number, month: number): number =>
  Temporal.PlainYearMonth.from({ year, month }).daysInMonth;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readPeriods = (result: unknown): BrowseCalendarPeriod[] =>
  executedRows(result)
    .filter(isRecord)
    .flatMap((row) => {
      const value = row["value"];
      const count = row["count"];
      return typeof value === "number" && typeof count === "number"
        ? [{ value, count }]
        : [];
    });

export const readBrowseCalendarHandler = async (
  query: ReadBrowseCalendarQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const admitted = admittedCountry(query.country);
  if (admitted.kind === "answer") {
    return admitted.answer;
  }
  const { country } = admitted;
  const { court, month, year } = query;
  if (month !== undefined && year === undefined) {
    return status(400, { message: "A month needs its year" });
  }

  if (year === undefined) {
    const rows = readPeriods(
      await caseLawDb(
        async (tx) => await tx.execute(courtYearsStatement(country, court)),
      ),
    );
    return {
      level: "years",
      periods: rows.filter((row) => row.value >= 0),
      undated: rows.find((row) => row.value < 0)?.count ?? 0,
    } satisfies BrowseCalendar;
  }

  const paddedYear = String(year).padStart(4, "0");
  const range: PeriodRange =
    month === undefined
      ? { start: `${paddedYear}-01-01`, parts: 12, unit: "month" }
      : {
          start: `${paddedYear}-${String(month).padStart(2, "0")}-01`,
          parts: daysInMonth(year, month),
          unit: "day",
        };
  const periods = readPeriods(
    await caseLawDb(
      async (tx) =>
        await tx.execute(periodCountsStatement(country, court, range)),
    ),
  );
  return {
    level: month === undefined ? "months" : "days",
    periods,
    undated: 0,
  } satisfies BrowseCalendar;
};
