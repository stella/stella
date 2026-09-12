import { expect, test } from "bun:test";

import {
  COURT_WEIGHT_SEED,
  courtWeightMapFromSeed,
} from "@/api/handlers/case-law/court-weight-seed";
import {
  COURT_TIER_LABELS,
  courtTierLabel,
  type CourtTierLabel,
} from "@/api/lib/case-law/court-weights";
import {
  groupCourtsByTier,
  labelSourceBuckets,
  type SearchFacetBucket,
} from "@/api/lib/case-law/decision-search-facets";
import {
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";

const bucket = (value: string, count: number): SearchFacetBucket => ({
  value,
  label: null,
  count,
});

const courtWeights = courtWeightMapFromSeed();

/**
 * Both directions of the declared set: every rank on the pinned scale produces
 * a label the response declares, and every declared label is a rank's answer.
 * A label declared but unreachable is a value the frontend renders a heading
 * for and never sees.
 */
test("the declared tier labels are exactly the ones the rank scale produces", () => {
  const produced = new Set<CourtTierLabel>();
  for (let tier = LOWEST_COURT_TIER; tier <= HIGHEST_COURT_TIER; tier += 1) {
    produced.add(courtTierLabel(tier));
  }

  expect(produced).toEqual(new Set(COURT_TIER_LABELS));
});

// The registry's own `tier_label` column is free text an operator writes per
// jurisdiction ("appeal", "district"); the response's tiers are not, so the
// rank is what decides them.
test("every seeded rank maps onto a declared tier", () => {
  const labels = COURT_WEIGHT_SEED.map((row) => courtTierLabel(row.tier));

  expect(labels.every((label) => COURT_TIER_LABELS.includes(label))).toBe(true);
});

test("courts group into the apex-first tiers of their jurisdiction", () => {
  const grouped = groupCourtsByTier({
    buckets: [
      bucket("Krajský soud v Brně", 5),
      bucket("Ústavní soud", 2),
      bucket("Nejvyšší soud", 9),
    ],
    country: "CZE",
    courtWeights,
    perTierLimit: LIMITS.caseLawFacetLimit,
  });

  expect(
    grouped.map((tier) => [tier.tierLabel, tier.courts.map((c) => c.value)]),
  ).toEqual([
    ["constitutional", ["Ústavní soud"]],
    ["supreme", ["Nejvyšší soud"]],
    ["regional", ["Krajský soud v Brně"]],
  ]);
});

// A court no jurisdiction ranks still has to be selectable; it groups with
// every other unranked court rather than disappearing from the rail.
test("a court no pattern ranks groups under `other`", () => {
  const grouped = groupCourtsByTier({
    buckets: [bucket("Nejvyšší soud", 1), bucket("Tribunal of Nowhere", 3)],
    country: "CZE",
    courtWeights,
    perTierLimit: LIMITS.caseLawFacetLimit,
  });

  expect(grouped.at(-1)).toEqual({
    tierLabel: "other",
    courts: [bucket("Tribunal of Nowhere", 3)],
  });
});

test("a tier no matched court belongs to is left out", () => {
  const grouped = groupCourtsByTier({
    buckets: [bucket("Ústavní soud", 4)],
    country: "CZE",
    courtWeights,
    perTierLimit: LIMITS.caseLawFacetLimit,
  });

  expect(grouped.map((tier) => tier.tierLabel)).toEqual(["constitutional"]);
});

test("courts inside a tier are ordered by decisions, then by name", () => {
  const grouped = groupCourtsByTier({
    buckets: [
      bucket("Krajský soud v Ostravě", 3),
      bucket("Krajský soud v Brně", 3),
      bucket("Městský soud v Praze", 8),
    ],
    country: "CZE",
    courtWeights,
    perTierLimit: LIMITS.caseLawFacetLimit,
  });

  expect(grouped.at(0)?.courts.map((court) => court.value)).toEqual([
    "Městský soud v Praze",
    "Krajský soud v Brně",
    "Krajský soud v Ostravě",
  ]);
});

// A source whose name the read did not answer for keeps a null label rather
// than borrowing the next row's.
test("source buckets take their own name, or none", () => {
  expect(
    labelSourceBuckets(
      [bucket("source-a", 4), bucket("source-b", 1)],
      new Map([["source-a", "Nejvyšší soud ČR"]]),
    ),
  ).toEqual([
    { value: "source-a", label: "Nejvyšší soud ČR", count: 4 },
    { value: "source-b", label: null, count: 1 },
  ]);
});

/**
 * The cap is per tier, and it is applied after the grouping. Capping the
 * courts before they are ranked is what lost Nejvyšší správní soud behind
 * twenty regional courts with longer dockets: an apex court publishes fewer
 * decisions than the courts below it by construction, so its presence can
 * never be made to depend on that comparison.
 */
test("an apex court survives a jurisdiction full of busier lower courts", () => {
  const busyRegionalCourts = Array.from({ length: 40 }, (_, index) => ({
    value: `Krajský soud ${String(index).padStart(2, "0")}`,
    label: null,
    count: 5000 + index,
  }));

  const grouped = groupCourtsByTier({
    buckets: [...busyRegionalCourts, bucket("Nejvyšší správní soud", 12)],
    country: "CZE",
    courtWeights,
    perTierLimit: LIMITS.caseLawFacetLimit,
  });

  expect(grouped.find((tier) => tier.tierLabel === "supreme")?.courts).toEqual([
    bucket("Nejvyšší správní soud", 12),
  ]);
  // The cap still bounds what each tier lists.
  for (const tier of grouped) {
    expect(tier.courts.length).toBeLessThanOrEqual(LIMITS.caseLawFacetLimit);
  }
  expect(
    grouped.find((tier) => tier.tierLabel === "regional")?.courts,
  ).toHaveLength(LIMITS.caseLawFacetLimit);
});
