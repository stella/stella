import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  canonicalCzechReviewCourt,
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
  test.each(["Okresního soudu v Ostravě", "Okresního soudu v Opavě"])(
    "binds a reversal to the named court when docket and date coincide: %s",
    (court) => {
      const reviews = extractCzechAppealReviews({
        header:
          "proti rozsudku Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 a rozsudku Okresního soudu v Opavě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35",
        holding: `I. Rozsudek ${court} ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 se ruší. II. Ve zbývajícím rozsahu se ústavní stížnost odmítá.`,
      });
      expect(
        reviews.map(({ reviewedCourt, outcome }) => ({
          reviewedCourt,
          outcome,
        })),
      ).toEqual([
        {
          reviewedCourt: "Okresní soud v Ostravě",
          outcome:
            court === "Okresního soudu v Ostravě" ? "overturned" : "upheld",
        },
        {
          reviewedCourt: "Okresní soud v Opavě",
          outcome:
            court === "Okresního soudu v Opavě" ? "overturned" : "upheld",
        },
      ]);
    },
  );

  test("abstains when the holding omits the court of otherwise identical targets", () => {
    const reviews = extractCzechAppealReviews({
      header:
        "proti rozsudku Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 a rozsudku Okresního soudu v Opavě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35",
      holding:
        "I. Rozsudek ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 se ruší. II. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
    });
    expect(reviews.map(({ outcome }) => outcome)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  test("matches an explicit court even when the holding omits the decision date", () => {
    const reviews = extractCzechAppealReviews({
      header:
        "proti rozsudku Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 a rozsudku Okresního soudu v Opavě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35",
      holding:
        "Rozsudek Okresního soudu v Opavě č. j. 25 C 20/2024-35 se ruší.",
    });
    expect(reviews.map(({ outcome }) => outcome)).toEqual([
      "unknown",
      "overturned",
    ]);
  });

  test("a reversal without a docket cannot make its remaining rejection conclusive", () => {
    const reviews = extractCzechAppealReviews({
      header:
        "proti rozsudku Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 a rozsudku Okresního soudu v Opavě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35",
      holding:
        "I. Rozsudek Okresního soudu v Ostravě se ruší. II. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
    });
    expect(reviews.map(({ outcome }) => outcome)).toEqual([
      "unknown",
      "upheld",
    ]);
  });

  test.each([
    "Rozsudek Krajského soudu v Brně ze dne 16. 1. 2025, č. j. 25 A 20/2024-35 se ruší.",
    "Rozsudek Krajského soudu v Brně se ruší.",
  ])(
    "does not apply a disposition expressly naming a different court: %s",
    (holding) => {
      expect(
        extractCzechAppealReviews({
          ...nssPair,
          holding,
        }).at(0)?.outcome,
      ).toBe("unknown");
    },
  );

  test("abstains when a named court falls outside the holding grammar", () => {
    expect(
      extractCzechAppealReviews({
        header:
          "proti rozsudku Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35",
        holding:
          "Rozsudek Okresního soudu Plzeň-město ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 se ruší. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
      }).at(0)?.outcome,
    ).toBe("unknown");
  });

  test("keeps declaratory publisher paragraphs separate from a later annulment", () => {
    const reviews = extractCzechAppealReviews({
      header:
        "proti usnesení Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681, usnesení Krajského soudu v Ústí nad Labem - pobočky v Liberci ze dne 20. září 2023 č. j. 35 Co 56/2022-652",
      holding: [
        "I. Usnesením Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681 byla porušena základní práva.",
        "II. Usnesení Krajského soudu v Ústí nad Labem - pobočky v Liberci ze dne 20. září 2023 č. j. 35 Co 56/2022-652 se ruší.",
        "III. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
      ],
    });
    expect(reviews.map(({ outcome }) => outcome)).toEqual([
      "upheld",
      "overturned",
    ]);
  });

  test.each([false, true])(
    "binds opposite dispositions to their own targets in one holding item (reverse order: %s)",
    (reverseOrder) => {
      // Adversarial arrangement of the public III. ÚS 2429/24 identities.
      const annulled =
        "Usnesení Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681 se ruší";
      const rejected =
        "ústavní stížnost proti usnesení Krajského soudu v Ústí nad Labem - pobočky v Liberci ze dne 20. září 2023 č. j. 35 Co 56/2022-652 se odmítá";
      const reviews = extractCzechAppealReviews({
        header:
          "proti usnesení Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681, usnesení Krajského soudu v Ústí nad Labem - pobočky v Liberci ze dne 20. září 2023 č. j. 35 Co 56/2022-652",
        holding: reverseOrder
          ? `${rejected} a ${annulled}.`
          : `${annulled} a ${rejected}.`,
      });
      expect(reviews.map(({ outcome }) => outcome)).toEqual([
        "overturned",
        "upheld",
      ]);
    },
  );

  test.each([
    "Ústavní stížnosti se odmítají.",
    "Kasační stížnosti se zamítají.",
    "Kasační stížnosti se odmítají.",
  ])("recognizes plural complaint dispositions: %s", (holding) => {
    expect(
      extractCzechAppealReviews({ ...nssPair, holding }).at(0)?.outcome,
    ).toBe("upheld");
  });

  test.each([
    {
      // II. ÚS 191/13: https://nalus.usoud.cz/Search/GetText.aspx?sz=2-191-13_2
      header:
        "proti usnesení Nejvyššího soudu České republiky ze dne 13. 11. 2012, č. j. 28 Cdo 3614/2011-103, a proti rozsudku Nejvyššího soudu České republiky ze dne 12. 9. 2012, č. j. 28 Cdo 599/2012-69",
      holding: "Ústavní stížnosti se odmítají.",
      dockets: ["28 Cdo 3614/2011-103", "28 Cdo 599/2012-69"],
    },
    {
      // NSS 10 As 204/2024-97: https://vyhledavac.nssoud.cz/DokumentOriginal/Index/743717
      header:
        "proti rozsudku Městského soudu v Praze ze dne 27. 9. 2024, č. j. 14 A 48/2023-110",
      holding: "I. Kasační stížnosti se zamítají.",
      dockets: ["14 A 48/2023-110"],
    },
    {
      // NSS 8 Azs 20/2026-81: https://vyhledavac.nssoud.cz/DokumentOriginal/Text/783003
      header:
        "proti rozsudku Městského soudu v Praze ze dne 15. 1. 2026, č. j. 19 A 59/2025-62",
      holding: "I. Kasační stížnosti se odmítají pro nepřijatelnost.",
      dockets: ["19 A 59/2025-62"],
    },
  ])(
    "reads real plural dispositions: $holding",
    ({ header, holding, dockets }) => {
      const reviews = extractCzechAppealReviews({ header, holding });
      expect(
        reviews.map(({ reviewedCaseNumber }) => reviewedCaseNumber),
      ).toEqual([...dockets]);
      expect(reviews.map(({ outcome }) => outcome)).toEqual(
        dockets.map(() => "upheld"),
      );
    },
  );

  test("retains district and appellate judgments with independent constitutional review outcomes", () => {
    const reviews = extractCzechAppealReviews({
      header:
        "proti rozsudku Krajského soudu v Ostravě ze dne 17. 2. 2025, č. j. 71 Co 22/2025-91 a rozsudku Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35",
      holding:
        "I. Rozsudek Okresního soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 C 20/2024-35 se ruší. II. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
    });
    expect(reviews).toEqual([
      {
        reviewedCaseNumber: "71 Co 22/2025-91",
        reviewedCourt: "Krajský soud v Ostravě",
        reviewedDecisionDate: "2025-02-17",
        outcome: "upheld",
      },
      {
        reviewedCaseNumber: "25 C 20/2024-35",
        reviewedCourt: "Okresní soud v Ostravě",
        reviewedDecisionDate: "2025-01-16",
        outcome: "overturned",
      },
    ]);
  });

  test.each([
    ["Okresního soudu v Ostravě", "Okresní soud v Ostravě"] as const,
    [
      "Okresního soudu ve Žďáru nad Sázavou",
      "Okresní soud ve Žďáru nad Sázavou",
    ] as const,
    ["Obvodního soudu pro Prahu 1", "Obvodní soud pro Prahu 1"] as const,
    ["Obvodního soudu pro Prahu 10", "Obvodní soud pro Prahu 10"] as const,
    ["Okresního soudu Praha-východ", "Okresní soud Praha-východ"] as const,
    ["Okresního soudu Praha - západ", "Okresní soud Praha-západ"] as const,
    ["Okresního soudu Brno‑venkov", "Okresní soud Brno-venkov"] as const,
    ["Okresního soudu Brno – venkov", "Okresní soud Brno-venkov"] as const,
    ["Okresního soudu Brno venkov", "Okresní soud Brno-venkov"] as const,
  ])(
    "retains district review targets named as %s",
    (printedCourt, canonicalCourt) => {
      const reviews = extractCzechAppealReviews({
        header: `proti rozsudku ${printedCourt} ze dne 16. 1. 2025, č. j. 25 C 20/2024-35`,
        holding: "Ústavní stížnost se zamítá.",
      });
      expect(reviews.at(0)?.reviewedCourt).toBe(canonicalCourt);
      expect(reviews.at(0)?.outcome).toBe("upheld");
      expect(canonicalCzechReviewCourt(printedCourt)).toBe(canonicalCourt);
      expect(canonicalCzechReviewCourt(canonicalCourt)).toBe(canonicalCourt);
    },
  );

  test("limits district seats without a preposition to their published compound names", () => {
    for (const court of [
      "Okresního soudu Praha-venkov",
      "Okresního soudu Brno-východ",
      "Okresního soudu Ostrava",
    ]) {
      expect(
        extractCzechAppealReviews({
          header: `proti rozsudku ${court} ze dne 16. 1. 2025, č. j. 25 C 20/2024-35`,
          holding: "Ústavní stížnost se zamítá.",
        }),
      ).toEqual([]);
    }
  });

  test("requires a numbered Prague district court in its published naming form", () => {
    for (const court of [
      "Obvodního soudu pro Prahu",
      "Obvodního soudu pro Prahu 11",
      "Obvodního soudu pro Jihlavu 1",
    ]) {
      expect(
        extractCzechAppealReviews({
          header: `proti rozsudku ${court} ze dne 16. 1. 2025, č. j. 25 C 20/2024-35`,
          holding: "Ústavní stížnost se zamítá.",
        }),
      ).toEqual([]);
    }
  });
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
  test.each([
    ["upheld", "unknown"],
    ["unknown", "upheld"],
    ["upheld", "upheld"],
    ["upheld", "overturned"],
    ["overturned", "upheld"],
  ] as const)(
    "combines duplicate official outcomes before filling from opening: %s, %s",
    (first, second) => {
      const official = extractCzechAppealReviews(nssPair).at(0);
      expect(official).toBeDefined();
      if (official === undefined) {
        return;
      }
      const metadata = {
        publisherReviews: [
          { ...official, outcome: first },
          { ...official, outcome: second },
        ],
      };
      const planned = planCzechAppealReviews({
        ...nssPair,
        holding: "Rozsudek se ruší.",
        metadata,
      });
      expect(planned).toHaveLength(1);
      expect(planned.at(0)?.outcome).toBe(
        first === "overturned" || second === "overturned"
          ? "unknown"
          : "upheld",
      );
      expect(planned.at(0)?.evidenceStatus).toBe("conflict");
      expect(metadata.publisherReviews.map(({ outcome }) => outcome)).toEqual([
        first,
        second,
      ]);
    },
  );

  test("duplicate publisher rows cannot conceal an unmatched opening target", () => {
    const opening = extractCzechAppealReviews(constitutionalPair);
    const first = opening.at(0);
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const planned = planCzechAppealReviews({
      ...constitutionalPair,
      metadata: { publisherReviews: opening.map(() => first) },
    });
    expect(
      planned.every(({ evidenceStatus }) => evidenceStatus === "conflict"),
    ).toBe(true);
    expect(
      planned.every(
        ({ openingEvidence }) => openingEvidence.length === opening.length,
      ),
    ).toBe(true);
  });

  test.each(["14274", "1427"])(
    "matches a bare holding docket to its published sheet %s",
    (sheet) => {
      const reviews = extractCzechAppealReviews({
        header: constitutionalPair.header.replace("14274", () => sheet),
        holding:
          "Usnesení Nejvyššího soudu č. j. 5 Tdo 1125/2023 se ruší. Ve zbývajícím rozsahu se ústavní stížnost odmítá.",
      });
      expect(reviews.map(({ outcome }) => outcome)).toEqual([
        "overturned",
        "upheld",
        "upheld",
      ]);
    },
  );

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
    ["Rozsudek se zrušuje ve výroku II.", "partly"],
    ["Rozsudek se ve výroku II. zrušuje.", "partly"],
    ["Rozsudek se zrušuje pouze ve výroku I.", "partly"],
    ["Rozsudek se zrušuje jen v části.", "partly"],
    ["Kasační stížnost se zčásti zamítá.", "unknown"],
    [
      "Kasační stížnost se zčásti zamítá; ve zbývající části se řízení přerušuje.",
      "pending",
    ],
    [
      "Rozsudek se zrušuje v části a ve zbytku se kasační stížnost zamítá.",
      "partly",
    ],
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

  test("Czech review extraction retains evidence across long adversarial court spacing and separators", () => {
    assertProperty(
      "Czech review extraction retains evidence across long adversarial court spacing and separators",
      fc.property(
        fc.integer({ min: 1024, max: 8192 }),
        fc.constantFrom(" ", "\n", "\u00a0"),
        fc.constantFrom("-", "–", "‑"),
        (length, gap, dash) => {
          const spacing = gap.repeat(length);
          expect(
            canonicalCzechReviewCourt(
              `Krajského soudu${spacing}České republiky`,
            ),
          ).toBe("Krajský soud");
          expect(
            canonicalCzechReviewCourt(
              `Okresního soudu Praha${spacing}${dash}${spacing}východ`,
            ),
          ).toBe("Okresní soud Praha-východ");
          const noise = dash.repeat(length);
          const reviews = extractCzechAppealReviews({
            header: `${noise}${spacing}${nssPair.header}`,
            holding: `${nssPair.holding}${spacing}${noise}`,
          });
          expect(reviews).toEqual(extractCzechAppealReviews(nssPair));
        },
      ),
      { numRuns: 20 },
    );
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
