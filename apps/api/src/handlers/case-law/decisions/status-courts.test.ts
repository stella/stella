import { expect, test } from "bun:test";

import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  caseLawCourtStatusRows,
  type CourtActivity,
} from "@/api/handlers/case-law/decisions/status-courts";
import type { FacetBucket } from "@/api/lib/search/types";

/**
 * The breakdown is what the corpus-status popover lists. Apex courts stand by
 * name because a reader recognises them; a jurisdiction's regional and
 * district courts run to dozens, so the tier is the fact and the row says how
 * many courts it stands for.
 */

const courtWeights = courtWeightMapFromSeed();

const bucket = (value: string, count: number): FacetBucket => ({
  value,
  count,
});

const activity = (
  entries: Readonly<Record<string, CourtActivity>>,
): ReadonlyMap<string, CourtActivity> => new Map(Object.entries(entries));

/** The breakdown of a corpus the buckets account for in full. */
const courtStatusRows = (
  options: Omit<Parameters<typeof caseLawCourtStatusRows>[0], "total">,
): ReturnType<typeof caseLawCourtStatusRows> =>
  caseLawCourtStatusRows({
    ...options,
    total: options.buckets.reduce((sum, { count }) => sum + count, 0),
  });

const CZ_REGIONAL = [
  "Krajský soud v Brně",
  "Krajský soud v Ostravě",
  "Krajský soud v Praze",
  "Krajský soud v Plzni",
];

test("names the apex courts and chips them from their own names", () => {
  const rows = courtStatusRows({
    activity: activity({
      "Ústavní soud": {
        addedLastDay: 3,
        addedLastWeek: 11,
        updatedAt: "2026-09-13T08:00:00+00:00",
      },
    }),
    buckets: [
      bucket("Nejvyšší soud", 900),
      bucket("Ústavní soud", 120),
      bucket("Nejvyšší správní soud", 400),
    ],
    country: "CZE",
    courtWeights,
  });

  expect(rows).toEqual([
    {
      type: "court",
      court: "Ústavní soud",
      courtAbbreviation: "ÚS",
      tier: "constitutional",
      decisions: 120,
      addedLastDay: 3,
      addedLastWeek: 11,
      updatedAt: "2026-09-13T08:00:00+00:00",
    },
    // Within a tier the largest court leads, so the order is the corpus's and
    // not the order the facets happened to arrive in.
    {
      type: "court",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      tier: "supreme",
      decisions: 900,
      addedLastDay: 0,
      addedLastWeek: 0,
      updatedAt: null,
    },
    {
      type: "court",
      court: "Nejvyšší správní soud",
      courtAbbreviation: "NSS",
      tier: "supreme",
      decisions: 400,
      addedLastDay: 0,
      addedLastWeek: 0,
      updatedAt: null,
    },
  ]);
});

test("collapses a wide regional tier into one row that sums it", () => {
  const rows = courtStatusRows({
    activity: activity({
      "Krajský soud v Brně": {
        addedLastDay: 1,
        addedLastWeek: 4,
        updatedAt: "2026-09-10T08:00:00+00:00",
      },
      "Krajský soud v Ostravě": {
        addedLastDay: 2,
        addedLastWeek: 5,
        updatedAt: "2026-09-12T08:00:00+00:00",
      },
    }),
    buckets: CZ_REGIONAL.map((court, index) => bucket(court, 100 - index)),
    country: "CZE",
    courtWeights,
  });

  expect(rows).toEqual([
    {
      type: "tier",
      tier: "regional",
      courts: 4,
      decisions: 100 + 99 + 98 + 97,
      addedLastDay: 3,
      addedLastWeek: 9,
      // The newest of the courts it stands for, not the first one read.
      updatedAt: "2026-09-12T08:00:00+00:00",
    },
  ]);
});

test("names a regional tier the corpus holds only a few courts of", () => {
  const rows = courtStatusRows({
    activity: activity({}),
    buckets: CZ_REGIONAL.slice(0, 2).map((court) => bucket(court, 10)),
    country: "CZE",
    courtWeights,
  });

  expect(rows.map((row) => row.type)).toEqual(["court", "court"]);
});

test("a court with no known abbreviation carries no chip", () => {
  const [row] = courtStatusRows({
    activity: activity({}),
    buckets: [bucket("Krajský soud v Brně", 10)],
    country: "CZE",
    courtWeights,
  });

  expect(row).toMatchObject({ type: "court", courtAbbreviation: null });
});

test("a tier the corpus holds no court of gets no heading row", () => {
  const rows = courtStatusRows({
    activity: activity({}),
    buckets: [bucket("Ústavní soud", 5)],
    country: "CZE",
    courtWeights,
  });

  expect(rows.map((row) => row.tier)).toEqual(["constitutional"]);
});

test("a total the buckets do not reach ends the breakdown with the rest", () => {
  const rows = caseLawCourtStatusRows({
    activity: activity({}),
    buckets: [bucket("Nejvyšší soud", 900), bucket("Ústavní soud", 120)],
    country: "CZE",
    courtWeights,
    total: 1500,
  });

  // The facets list the largest courts up to a limit; the rows still sum to
  // the corpus, with the courts beyond the limit as one row that names how
  // many were listed and carries no activity, because none was read.
  expect(rows.at(-1)).toEqual({
    type: "unlisted",
    tier: "other",
    listed: 2,
    decisions: 480,
  });
  expect(rows.reduce((sum, row) => sum + row.decisions, 0)).toBe(1500);
});

test("a total the buckets account for adds no row for the rest", () => {
  const rows = caseLawCourtStatusRows({
    activity: activity({}),
    buckets: [bucket("Nejvyšší soud", 900)],
    country: "CZE",
    courtWeights,
    total: 900,
  });

  expect(rows.map(({ type }) => type)).toEqual(["court"]);
});
