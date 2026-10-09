import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@stll/api-contract/case-law-court-tiers";
import { FACET_COUNT_TYPE } from "@stll/api-contract/search";
import { assertProperty } from "@stll/property-testing";

import {
  COURT_WEIGHT_SEED,
  courtWeightMapFromSeed,
} from "@/api/handlers/case-law/court-weight-seed";
import { courtTierLabel } from "@/api/lib/case-law/court-tiers";
import {
  cappedSourceFacetBuckets,
  decisionTypeKindBuckets,
  foldStatedDecisionTypeBuckets,
  groupCourtsByTier,
  presentCourtYear,
  labelSourceBuckets,
  type SearchFacetBucket,
} from "@/api/lib/case-law/decision-search-facets";
import { STATED_DECISION_TYPE_KINDS } from "@/api/lib/case-law/decision-type-kind";
import {
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

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

test("a stale directory court name is unranked and reported, and its peers are grouped as usual", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    // The stale name is off the listed tiers' caps: one court per tier, and
    // the apex court is the larger bucket.
    const grouped = groupCourtsByTier({
      buckets: [
        bucket("Supreme Court of the United States", 10),
        bucket("Court of Appeals for the First Circuit", 4),
        bucket("Supreme Court of the United States (stale)", 1),
      ],
      country: "USA",
      courtWeights,
      perTierLimit: 1,
    });
    expect(
      grouped.map((tier) => [tier.tierLabel, tier.courts.map((c) => c.value)]),
    ).toEqual([
      ["supreme", ["Supreme Court of the United States"]],
      ["regional", ["Court of Appeals for the First Circuit"]],
      ["other", ["Supreme Court of the United States (stale)"]],
    ]);
    expect(warn).toHaveBeenCalledWith(
      "case_law.court_rank.invalid_directory_identity",
      {
        country: "USA",
        lookup: "court_name",
        "court.identity": "Supreme Court of the United States (stale)",
        effect: "unranked",
      },
    );
  } finally {
    warn.mockRestore();
  }
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

/**
 * The registry column takes any integer and the ingestion role can write it,
 * so a rank outside the pinned scale reaches this lookup. Clamping a stray `5`
 * upward would present an unranked court as a constitutional one, which is the
 * loudest way to be wrong; it groups with the courts nobody ranked instead.
 */
test.each([0, -1, 5, 99, 2.5, Number.NaN])(
  "the rank %p is outside the scale and groups under `other`",
  (tier) => {
    expect(courtTierLabel(tier)).toBe("other");
  },
);

test("the ranks inside the scale keep their own tiers", () => {
  expect([1, 2, 3, 4].map((tier) => courtTierLabel(tier))).toEqual([
    "other",
    "regional",
    "supreme",
    "constitutional",
  ]);
});

// Exhaust the bounded probe's result domain, including both sides of the cap.
test("source bucket lower bounds appear only above the cap and survive labelling", () => {
  const cap = LIMITS.caseLawSourceFacetCountCap;
  const inputs = Array.from({ length: cap + 2 }, (_, count) =>
    bucket(String(count), count),
  );
  const names = new Map(inputs.map(({ value }) => [value, `source-${value}`]));
  const outputs = labelSourceBuckets(cappedSourceFacetBuckets(inputs), names);
  for (const [index, output] of outputs.entries()) {
    expect(output.count).toBe(Math.min(index, cap));
    expect(output.countType).toBe(
      index > cap ? FACET_COUNT_TYPE.AT_LEAST : FACET_COUNT_TYPE.EXACT,
    );
    expect(output.label).toBe(`source-${index}`);
  }
});

test("two stored spellings of one type collapse into one canonical bucket with the summed count", () => {
  expect(
    foldStatedDecisionTypeBuckets([
      bucket("usnesení", 5),
      bucket("rozsudek", 6),
      bucket("usn.", 2),
      bucket("zzz-nepojmenovaný-typ", 1),
    ]),
  ).toEqual([
    { value: "order", label: null, count: 7 },
    { value: "judgment", label: null, count: 6 },
    { value: "other", label: null, count: 1 },
  ]);
});

test("stored casings, joined lists and docket numbers collapse safely into canonical buckets", () => {
  expect(
    foldStatedDecisionTypeBuckets([
      bucket("uznesenie", 100),
      bucket("Uznesenie", 20),
      bucket("uznesenie,uznesenie", 7),
      bucket("nález,nález", 3),
      bucket("uznesenie,nález", 2),
      bucket("63 az 17/2026 - 28", 1),
    ]),
  ).toEqual([
    { value: "order", label: null, count: 127 },
    { value: "finding", label: null, count: 3 },
    { value: "other", label: null, count: 3 },
  ]);
});

test("the type facet is cut to its limit after the fold, not before", () => {
  // A full list of other kinds, each outranking either spelling of `order`
  // alone: cutting spellings before folding would drop `order`, whose two
  // spellings together outrank them all.
  const otherKinds = new Map<string, string>();
  for (const [stated, kind] of Object.entries(STATED_DECISION_TYPE_KINDS)) {
    if (kind !== "order" && kind !== "other" && !otherKinds.has(kind)) {
      otherKinds.set(kind, stated);
    }
  }
  const filler = [...otherKinds.values()]
    .slice(0, LIMITS.caseLawFacetLimit)
    .map((stated) => bucket(stated, 3));
  expect(filler.length).toBe(LIMITS.caseLawFacetLimit);

  const folded = foldStatedDecisionTypeBuckets([
    ...filler,
    bucket("usnesení", 2),
    bucket("usn.", 2),
  ]);
  expect(folded.at(0)).toEqual({ value: "order", label: null, count: 4 });
  expect(folded.length).toBe(LIMITS.caseLawFacetLimit);
});

test("a Postgres type bucket that is not a kind is a broken statement", () => {
  expect(decisionTypeKindBuckets([bucket("order", 3)])).toEqual([
    { value: "order", label: null, count: 3 },
  ]);
  expect(() => decisionTypeKindBuckets([bucket("usn.", 3)])).toThrow(
    "non-kind",
  );
});

test("court/year presentation shares hit abbreviations and keeps unavailable signals explicit", () => {
  expect(
    presentCourtYear({
      matrix: null,
      courts: [],
      country: "CZE",
      courtWeights,
    }),
  ).toBeNull();
  expect(
    presentCourtYear({
      matrix: {
        buckets: [
          { court: "Ústavní soud", year: 2024, count: 2 },
          { court: "omitted", year: 2024, count: 1 },
        ],
        truncated: false,
      },
      courts: [
        { tierLabel: "constitutional", courts: [bucket("Ústavní soud", 2)] },
      ],
      country: "CZE",
      courtWeights,
    }),
  ).toEqual({
    buckets: [
      {
        court: "Ústavní soud",
        courtName: "Ústavní soud",
        courtAbbreviation: "ÚS",
        tier: "constitutional",
        year: 2024,
        count: 2,
        citationSum: null,
        treatment: null,
      },
    ],
    truncated: true,
  });
});

test("every matrix court belongs to the filter rail and preserves its decision count", () => {
  assertProperty(
    "every matrix court belongs to the filter rail and preserves its decision count",
    fc.property(
      fc.uniqueArray(
        fc.record({
          court: fc.string({ minLength: 1, maxLength: 30 }),
          count: fc.integer({ min: 0, max: 10_000 }),
          visible: fc.boolean(),
        }),
        { selector: ({ court }) => court, maxLength: 30 },
      ),
      (rows) => {
        const allowed = rows.filter(({ visible }) => visible);
        const courts = [
          {
            tierLabel: "other",
            courts: allowed.map(({ court, count }) => bucket(court, count)),
          },
        ];
        const result = presentCourtYear({
          matrix: {
            buckets: rows.map(({ court, count }) => ({
              court,
              count,
              year: 2024,
            })),
            truncated: false,
          },
          courts: [
            {
              tierLabel: "other",
              courts: allowed.map(({ court, count }) => bucket(court, count)),
            },
          ],
          country: "CZE",
          courtWeights,
        });
        expect(
          result?.buckets.map(({ court, count }) => ({ court, count })),
        ).toEqual(allowed.map(({ court, count }) => ({ court, count })));
        expect(result?.truncated).toBe(allowed.length !== rows.length);
        for (const row of result?.buckets ?? []) {
          expect(
            courts.some(({ courts: tierCourts }) =>
              tierCourts.some(({ value }) => value === row.court),
            ),
          ).toBe(true);
          expect(row.count).toBeGreaterThanOrEqual(0);
          expect(row.tier).toBe("other");
          expect(row.citationSum).toBeNull();
          expect(row.treatment).toBeNull();
        }
      },
    ),
  );
});
