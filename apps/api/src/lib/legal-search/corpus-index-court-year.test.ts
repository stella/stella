import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  caseLawCourtYearSchema,
  CASE_LAW_COURT_YEAR_BUCKET_LIMIT,
} from "@stll/api-contract/case-law-court-year";
import { assertProperty } from "@stll/property-testing";

import {
  courtYearAggregation,
  parseCourtYearAggregation,
} from "./corpus-index-court-year";
import { corpusYearRanges } from "./corpus-index-search-facets";

const yearRanges = corpusYearRanges(2026);
const range = (key: string, count: number) => ({
  key,
  doc_count: count * 10,
  decisions: { value: count },
});
const courtBucket = (key: string, buckets: ReturnType<typeof range>[]) => ({
  key,
  years: { buckets },
});
const answer = (buckets: ReturnType<typeof courtBucket>[]) => ({
  buckets,
  sum_other_doc_count: 0,
  doc_count_error_upper_bound: 0,
});
const parse = (aggregation: unknown) =>
  parseCourtYearAggregation({ aggregation, yearRanges });

test("court/year counts partition the decisions rather than matching passages", () => {
  expect(
    parse(
      answer([
        courtBucket("Ústavní soud", [range("2024", 2), range("2025", 3)]),
        courtBucket("Nejvyšší soud", [range("2025", 5)]),
      ]),
    ),
  ).toEqual({
    buckets: [
      { court: "Nejvyšší soud", year: 2025, count: 5 },
      { court: "Ústavní soud", year: 2025, count: 3 },
      { court: "Ústavní soud", year: 2024, count: 2 },
    ],
    truncated: false,
  });
});

test("unreadable matrix answers remain unavailable", () => {
  for (const aggregation of [
    null,
    {},
    { buckets: [] },
    answer([
      { key: "court", years: { buckets: [{ key: "2024", doc_count: 20 }] } },
    ]),
  ]) {
    expect(parse(aggregation)).toBeNull();
  }
  for (const count of [-1, Number.NaN, Infinity]) {
    expect(
      parse(answer([courtBucket("court", [range("2024", count)])])),
    ).toBeNull();
  }
});

test("empty results are complete while omitted courts, years and merge candidates are truncated", () => {
  expect(parse(answer([]))).toEqual({ buckets: [], truncated: false });
  expect(parse({ ...answer([]), sum_other_doc_count: 1 })?.truncated).toBe(
    true,
  );
  expect(parse({ ...answer([]), doc_count_error_upper_bound: 1 })).toBeNull();
  expect(
    parse(answer([courtBucket("court", [range("1899", 1)])]))?.truncated,
  ).toBe(true);
});

test("the published matrix has at most 400 buckets and deterministic ties", () => {
  const aggregation = answer(
    Array.from({ length: 4 }, (_slot, index) =>
      courtBucket(
        `court-${index}`,
        yearRanges.map(({ key }) => range(key, 1)),
      ),
    ),
  );
  const result = parse(aggregation);
  expect(result?.buckets).toHaveLength(CASE_LAW_COURT_YEAR_BUCKET_LIMIT);
  expect(result?.truncated).toBe(true);
  expect(result).toEqual(parse(answer(aggregation.buckets.toReversed())));
});

test("court/year partitions preserve nonnegative counts and their court identities", () => {
  assertProperty(
    "corpus court/year partitions preserve counts and court identity",
    fc.property(
      fc.uniqueArray(
        fc.record({
          court: fc.string({ minLength: 1, maxLength: 30 }),
          counts: fc.array(fc.integer({ min: 0, max: 10_000 }), {
            minLength: 1,
            maxLength: 20,
          }),
        }),
        { selector: ({ court }) => court, maxLength: 10 },
      ),
      (rows) => {
        const result = parse(
          answer(
            rows.map(({ court: name, counts }) =>
              courtBucket(
                name,
                counts.map((count, index) =>
                  range(String(2000 + index), count),
                ),
              ),
            ),
          ),
        );
        expect(result).not.toBeNull();
        expect(result?.truncated).toBe(false);
        expect(result?.buckets.reduce((sum, { count }) => sum + count, 0)).toBe(
          rows.reduce(
            (sum, { counts }) =>
              sum + counts.reduce((total, count) => total + count, 0),
            0,
          ),
        );
        const courts = new Set(rows.map(({ court }) => court));
        for (const bucket of result?.buckets ?? []) {
          expect(courts.has(bucket.court)).toBe(true);
          expect(bucket.count).toBeGreaterThanOrEqual(0);
        }
      },
    ),
  );
});

test("the matrix contract bounds the response and represents unavailable index signals", () => {
  const bucket = {
    court: "Ústavní soud",
    courtName: "Ústavní soud",
    courtAbbreviation: "ÚS",
    tier: "constitutional",
    year: 2024,
    count: 3,
    citationSum: null,
    treatment: null,
  };
  expect(v.safeParse(caseLawCourtYearSchema, null).success).toBe(true);
  expect(
    v.safeParse(caseLawCourtYearSchema, { buckets: [bucket], truncated: false })
      .success,
  ).toBe(true);
  expect(
    v.safeParse(caseLawCourtYearSchema, {
      buckets: [{ ...bucket, citationSum: -1 }],
      truncated: false,
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(caseLawCourtYearSchema, {
      buckets: Array.from({ length: 401 }, () => bucket),
      truncated: true,
    }).success,
  ).toBe(false);
});

test("the engine plan bounds intermediate courts and counts document identities in calendar-year ranges", () => {
  const aggregation = courtYearAggregation({
    decisionCountField: "document_id",
    yearRanges,
  });
  expect(aggregation.terms.size).toBeLessThanOrEqual(
    CASE_LAW_COURT_YEAR_BUCKET_LIMIT,
  );
  expect(aggregation.terms.segment_size).toBeLessThanOrEqual(
    aggregation.terms.size * 2,
  );
  expect(aggregation.aggs.years.range.ranges).toBe(yearRanges);
  expect(aggregation.aggs.years.aggs.decisions).toEqual({
    cardinality: { field: "document_id" },
  });
});
