import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  extractCzechAppealReviews,
  planCzechAppealReviews,
} from "./cz-appeal-reviews";

// NSS 7 As 32/2025-30, 20 October 2025: the reviewed judgment is held
// under 25 A 20/2024-35 (Krajský soud v Ostravě, 16 January 2025).
const nssPair = {
  header:
    "Nejvyšší správní soud rozhodl v řízení o kasační stížnosti žalobců proti rozsudku Krajského soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 A 20/2024-35, takto:",
  holding: "Kasační stížnost se zamítá.",
};

// Public opening and holding excerpts from III. ÚS 3031/24, also retained
// in parsers/__fixtures__/cz-us-iii-us-3031-24.html.gz.
const constitutionalPair = {
  header:
    "proti usnesení Nejvyššího soudu ze dne 19. června 2024 č. j. 5 Tdo 1125/2023-14274, rozsudku Vrchního soudu v Praze ze dne 4. května 2023 č. j. 4 To 17/2023-13904 a rozsudku Krajského soudu v Hradci Králové ze dne 21. září 2022 č. j. 7 T 11/2015-13532",
  holding: "Ústavní stížnost se zamítá.",
};

describe("Czech appeal history", () => {
  test("keeps separate reviewed judgments with the same file number on different dates", () => {
    const reviews = extractCzechAppealReviews({
      header:
        "proti usnesení Nejvyššího soudu ze dne 6. 8. 2024 č. j. 27 Cdo 541/2024 a usnesení Nejvyššího soudu ze dne 7. 8. 2024 č. j. 27 Cdo 541/2024",
      holding:
        "I. Usnesení Nejvyššího soudu ze dne 6. 8. 2024 č. j. 27 Cdo 541/2024 se ruší. II. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
    });
    expect(
      reviews.map(({ reviewedDecisionDate, outcome }) => ({
        reviewedDecisionDate,
        outcome,
      })),
    ).toEqual([
      { reviewedDecisionDate: "2024-08-06", outcome: "overturned" },
      { reviewedDecisionDate: "2024-08-07", outcome: "upheld" },
    ]);
    const metadata = { publisherReviews: reviews };
    expect(
      planCzechAppealReviews({
        header: nssPair.header,
        holding: nssPair.holding,
        metadata,
      }).every((review) => review.evidenceStatus === "conflict"),
    ).toBe(true);
  });
  test("uses publisher review metadata first and retains conflicting opening evidence", () => {
    const openingReview = extractCzechAppealReviews(nssPair).at(0);
    expect(openingReview).toBeDefined();
    if (openingReview === undefined) {
      return;
    }
    const metadataReview = {
      ...openingReview,
      reviewedCaseNumber: "25 A 184/2021-61",
      reviewedDecisionDate: "2022-10-27",
    };
    expect(
      planCzechAppealReviews({
        ...nssPair,
        metadata: { publisherReviews: [metadataReview] },
      }),
    ).toEqual([
      {
        ...metadataReview,
        source: "metadata",
        evidenceStatus: "conflict",
        openingEvidence: [openingReview],
      },
    ]);
    expect(
      planCzechAppealReviews({
        ...nssPair,
        metadata: { publisherReviews: [openingReview] },
      }).at(0)?.evidenceStatus,
    ).toBe("consistent");
    expect(
      planCzechAppealReviews({
        header: "",
        holding: "",
        metadata: { publisherReviews: [openingReview] },
      }).at(0)?.evidenceStatus,
    ).toBe("metadata_only");
    expect(
      planCzechAppealReviews({ ...nssPair, metadata: {} }).at(0)?.source,
    ).toBe("opening");
    expect(
      planCzechAppealReviews({
        ...nssPair,
        metadata: {
          publisherReviews: [{ ...openingReview, outcome: "unknown" }],
        },
      }).at(0)?.outcome,
    ).toBe("upheld");
    const disagreement = planCzechAppealReviews({
      ...nssPair,
      metadata: {
        publisherReviews: [{ ...openingReview, outcome: "overturned" }],
      },
    }).at(0);
    expect(disagreement?.outcome).toBe("overturned");
    expect(disagreement?.evidenceStatus).toBe("conflict");
    expect(
      planCzechAppealReviews({
        ...nssPair,
        metadata: {
          publisherReviews: [],
          publisherReviewMetadata: [
            { status: "incomplete", reason: "missing_court", fields: {} },
          ],
        },
      }).at(0)?.evidenceStatus,
    ).toBe("conflict");
  });
  test("links the Ostrava judgment reviewed by NSS 7 As 32/2025-30 with its outcome", () => {
    expect(extractCzechAppealReviews(nssPair)).toEqual([
      {
        reviewedCaseNumber: "25 A 20/2024-35",
        reviewedCourt: "Krajský soud v Ostravě",
        reviewedDecisionDate: "2025-01-16",
        outcome: "upheld",
      },
    ]);
  });

  test("links the earlier Ostrava judgment reviewed by NSS 1 As 273/2022-55", () => {
    expect(
      extractCzechAppealReviews({
        header:
          "v řízení o kasační stížnosti žalovaného proti rozsudku Krajského soudu v Ostravě ze dne 27. 10. 2022, č. j. 25 A 184/2021‑61, takto:",
        holding: "Kasační stížnost se zamítá.",
      }),
    ).toEqual([
      {
        reviewedCaseNumber: "25 A 184/2021-61",
        reviewedCourt: "Krajský soud v Ostravě",
        reviewedDecisionDate: "2022-10-27",
        outcome: "upheld",
      },
    ]);
  });

  test("retains every expressly reviewed judgment in a constitutional complaint", () => {
    expect(extractCzechAppealReviews(constitutionalPair)).toEqual([
      {
        reviewedCaseNumber: "5 Tdo 1125/2023-14274",
        reviewedCourt: "Nejvyšší soud",
        reviewedDecisionDate: "2024-06-19",
        outcome: "upheld",
      },
      {
        reviewedCaseNumber: "4 To 17/2023-13904",
        reviewedCourt: "Vrchní soud v Praze",
        reviewedDecisionDate: "2023-05-04",
        outcome: "upheld",
      },
      {
        reviewedCaseNumber: "7 T 11/2015-13532",
        reviewedCourt: "Krajský soud v Hradci Králové",
        reviewedDecisionDate: "2022-09-21",
        outcome: "upheld",
      },
    ]);
  });

  test.each([
    ["Kasační stížnost se odmítá.", "upheld"],
    [
      "Rozsudek Krajského soudu v Ostravě se zrušuje a věc se vrací tomuto soudu k dalšímu řízení.",
      "overturned",
    ],
    ["Rozsudek se mění takto: žaloba se zamítá.", "overturned"],
    [
      "Rozsudek se ve všech výrocích zrušuje a věc se vrací k dalšímu řízení.",
      "overturned",
    ],
    [
      "Rozsudek se v části zrušuje a ve zbytku se kasační stížnost zamítá.",
      "partly",
    ],
    ["Rozsudek se ve výroku o nákladech řízení zrušuje.", "partly"],
    [
      "I. Kasační stížnost se zamítá. II. Ustanovený advokát se zprošťuje zastupování. III. Usnesení o ustanovení advokáta se zrušuje.",
      "upheld",
    ],
    ["Ustanovenému advokátovi se mění výše odměny.", "unknown"],
    ["Kasační stížnosti se přiznává odkladný účinek.", "unknown"],
    ["Řízení o kasační stížnosti se přerušuje.", "pending"],
    ["Řízení o dovolání se přerušuje.", "pending"],
    ["Řízení o ústavní stížnosti se přerušuje.", "pending"],
    ["Řízení se zastavuje.", "unknown"],
    ["", "unknown"],
  ] as const)(
    "reads the disposition only from the holding: %s",
    (holding, outcome) => {
      expect(
        extractCzechAppealReviews({ ...nssPair, holding }).at(0)?.outcome,
      ).toBe(outcome);
    },
  );

  test("does not confuse a quoted outcome in the opening with the holding", () => {
    expect(
      extractCzechAppealReviews({
        header: `${nssPair.header} Kasační stížnost se zamítá.`,
        holding: "",
      }).at(0)?.outcome,
    ).toBe("unknown");
  });

  test("requires the review formula, explicit court, date and docket", () => {
    for (const header of [
      "Srov. rozsudek Krajského soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 A 20/2024-35.",
      "V odůvodnění soud uvedl, že rozsudek č. j. 25 A 20/2024-35 byl napaden kasační stížností.",
      "proti rozsudku č. j. 25 A 20/2024-35",
      "proti rozsudku Krajského soudu v Ostravě č. j. 25 A 20/2024-35",
      "proti rozsudku Krajského soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 A 20/2024-123456",
      "proti rozsudku Krajského soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 A 20/2024-neplatné",
      "proti rozhodnutí Ministerstva vnitra ze dne 16. 1. 2025, č. j. 25 A 20/2024-35",
    ]) {
      expect(
        extractCzechAppealReviews({ header, holding: nssPair.holding }),
      ).toEqual([]);
    }
  });

  test("does not extend a target list past intervening prose", () => {
    expect(
      extractCzechAppealReviews({
        header: `${nssPair.header.replace("takto:", "")} Jiná otázka byla předmětem dokazování a rozsudku Vrchního soudu v Praze ze dne 4. 5. 2023 č. j. 4 To 17/2023-13904.`,
        holding: nssPair.holding,
      }),
    ).toHaveLength(1);
  });

  test("recognizes an NS appeal of a high court judgment with a written month", () => {
    expect(
      extractCzechAppealReviews({
        header:
          "o dovolání proti rozsudku Vrchního soudu v Praze ze dne 20. června 2024, č. j. 5 Cmo 50/2024-156",
        holding: "Dovolání se odmítá.",
      }),
    ).toEqual([
      {
        reviewedCaseNumber: "5 Cmo 50/2024-156",
        reviewedCourt: "Vrchní soud v Praze",
        reviewedDecisionDate: "2024-06-20",
        outcome: "upheld",
      },
    ]);
  });

  test("does not attach the reversal of one constitutional target to another", () => {
    // III. ÚS 2429/24: the Supreme Court judgment was annulled; the
    // remaining complaint was rejected. Excerpts from the retained fixture.
    const reviews = extractCzechAppealReviews({
      header:
        "proti usnesení Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681, usnesení Krajského soudu v Ústí nad Labem - pobočky v Liberci ze dne 20. září 2023 č. j. 35 Co 56/2022-652",
      holding:
        "I. Usnesením Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681 byla porušena základní práva stěžovatelky. II. Usnesení Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681 se ruší. III. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
    });
    expect(reviews).toHaveLength(2);
    expect(reviews.at(0)?.outcome).toBe("overturned");
    expect(reviews.at(1)?.outcome).toBe("upheld");
    expect(reviews.at(1)?.reviewedCourt).toBe(
      "Krajský soud v Ústí nad Labem – pobočka v Liberci",
    );
  });

  test("uses the registered name when the opening names the Czech Republic", () => {
    expect(
      extractCzechAppealReviews({
        header:
          "proti usnesení Nejvyššího soudu České republiky ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681",
        holding: "Usnesení se ruší.",
      }).at(0)?.reviewedCourt,
    ).toBe("Nejvyšší soud");
  });

  test("Czech review extraction preserves links across publisher whitespace and Unicode forms", () => {
    assertProperty(
      "Czech review extraction preserves links across publisher whitespace and Unicode forms",
      fc.property(
        fc.constantFrom(" ", "\n", "\u00a0", "\u202f"),
        fc.constantFrom("NFC", "NFD"),
        (gap, form) => {
          const varied = {
            header: normalizeUnicode(nssPair.header, form).replaceAll(
              " ",
              () => gap,
            ),
            holding: normalizeUnicode(nssPair.holding, form).replaceAll(
              " ",
              () => gap,
            ),
          };
          expect(extractCzechAppealReviews(varied)).toEqual(
            extractCzechAppealReviews(nssPair),
          );
        },
      ),
    );
  });
});
