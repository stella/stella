import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { courtAbbreviation } from "@stll/api-contract/court-abbreviations";
import { assertProperty } from "@stll/property-testing";

import {
  combineCourtFilters,
  readCourtFilter,
  storedCourtIdentities,
} from "@/api/mcp/case-law-court-filter";

/**
 * Court spellings as publishers store them, per stored country: apex courts
 * with and without the country appended, and seat-named courts the registry
 * gives no abbreviation.
 */
const STORED_SPELLINGS = {
  CZE: [
    "Nejvyšší soud",
    "Nejvyšší soud České republiky",
    "Nejvyšší správní soud",
    "Ústavní soud",
    "Ústavní soud České republiky",
    "Krajský soud v Brně",
    "Krajský soud v Ostravě",
    "Městský soud v Praze",
  ],
  SVK: [
    "Najvyšší súd",
    "Najvyšší súd Slovenskej republiky",
    "Najvyšší správny súd",
    "Najvyšší správny súd Slovenskej republiky",
    "Ústavný súd",
    "Ústavný súd Slovenskej republiky",
    "Krajský súd v Bratislave",
    "Krajský súd v Košiciach",
    "Okresný súd Žilina",
  ],
  POL: [
    "Sąd Najwyższy",
    "Naczelny Sąd Administracyjny",
    "Trybunał Konstytucyjny",
    "Sąd Okręgowy w Warszawie",
    "Sąd Rejonowy dla Warszawy-Śródmieścia",
  ],
  HUN: [
    "Kúria",
    "Alkotmánybíróság",
    "Legfelsőbb Bíróság",
    "Fővárosi Törvényszék",
  ],
  EU: ["Court of Justice", "General Court"],
} as const satisfies Record<string, readonly string[]>;

const storedCourtsArb = fc
  .constantFrom(...Object.entries(STORED_SPELLINGS))
  .chain(([country, spellings]) =>
    fc.record({
      country: fc.constant(country),
      courts: fc.shuffledSubarray([...spellings], { minLength: 1 }),
    }),
  );

const sorted = (values: readonly string[]) => [...values].toSorted();

/** Every stored spelling the registry gives this abbreviation. */
const spellingsOf = ({
  abbreviation,
  country,
  courts,
}: {
  abbreviation: string;
  country: string;
  courts: readonly string[];
}) =>
  courts.filter(
    (court) => courtAbbreviation({ country, court }) === abbreviation,
  );

describe("court filters read a court as every spelling the corpus stores it under", () => {
  test("an abbreviation reads as exactly its court's stored spellings", () => {
    assertProperty(
      "an abbreviation reads as exactly its court's stored spellings",
      fc.property(storedCourtsArb, ({ country, courts }) => {
        const identities = storedCourtIdentities(country, courts);
        const abbreviations = new Set(
          courts.flatMap(
            (court) => courtAbbreviation({ country, court }) ?? [],
          ),
        );
        for (const abbreviation of abbreviations) {
          const reading = readCourtFilter({ court: abbreviation, identities });
          expect(reading.type).toBe("court");
          if (reading.type !== "court") {
            continue;
          }
          expect(sorted(reading.courts)).toEqual(
            sorted(spellingsOf({ abbreviation, country, courts })),
          );
        }
      }),
    );
  });

  test("a stored spelling reads as its court and never as another", () => {
    assertProperty(
      "a stored spelling reads as its court and never as another",
      fc.property(storedCourtsArb, ({ country, courts }) => {
        const identities = storedCourtIdentities(country, courts);
        for (const court of courts) {
          const reading = readCourtFilter({ court, identities });
          expect(reading.type).toBe("court");
          if (reading.type !== "court") {
            continue;
          }
          const abbreviation = courtAbbreviation({ country, court });
          expect(sorted(reading.courts)).toEqual(
            abbreviation === undefined
              ? [court]
              : sorted(spellingsOf({ abbreviation, country, courts })),
          );
        }
      }),
    );
  });

  test("identities partition the stored spellings", () => {
    assertProperty(
      "identities partition the stored spellings",
      fc.property(storedCourtsArb, ({ country, courts }) => {
        const identities = storedCourtIdentities(country, courts);
        expect(
          sorted(identities.flatMap(({ spellings }) => spellings)),
        ).toEqual(sorted(courts));
        for (const { abbreviation, spellings } of identities) {
          for (const court of spellings) {
            expect(courtAbbreviation({ country, court })).toBe(abbreviation);
          }
        }
      }),
    );
  });

  test("NS reads as both stored spellings of the Slovak Supreme Court", () => {
    const identities = storedCourtIdentities("SVK", STORED_SPELLINGS.SVK);
    const reading = readCourtFilter({ court: "NS", identities });

    expect(reading).toMatchObject({
      type: "court",
      courts: ["Najvyšší súd", "Najvyšší súd Slovenskej republiky"],
      warning: { code: "filter_read" },
    });
  });

  test("a value naming two different courts is still dropped", () => {
    const identities = storedCourtIdentities("SVK", STORED_SPELLINGS.SVK);

    expect(readCourtFilter({ court: "Krajský súd", identities })).toMatchObject(
      { type: "dropped", warning: { code: "filter_dropped" } },
    );
  });

  test("a verbatim spelling of a one-spelling court carries no note", () => {
    const identities = storedCourtIdentities("CZE", ["Nejvyšší soud"]);

    expect(readCourtFilter({ court: "Nejvyšší soud", identities })).toEqual({
      type: "court",
      courts: ["Nejvyšší soud"],
      warning: null,
    });
  });
});

describe("court and courts combine as the search ANDs them", () => {
  const SUPREME = [
    "Najvyšší súd",
    "Najvyšší súd Slovenskej republiky",
  ] as const;

  test("a one-spelling court stays the court filter", () => {
    expect(
      combineCourtFilters({ court: ["Ústavný súd"], courts: undefined }),
    ).toEqual({
      court: "Ústavný súd",
      courts: undefined,
      courtSpellings: ["Ústavný súd"],
    });
  });

  test("a several-spelling court moves into courts", () => {
    expect(combineCourtFilters({ court: SUPREME, courts: undefined })).toEqual({
      court: undefined,
      courts: [...SUPREME],
      courtSpellings: SUPREME,
    });
  });

  test("a several-spelling court intersects a court list", () => {
    expect(
      combineCourtFilters({
        court: SUPREME,
        courts: ["Najvyšší súd", "Ústavný súd"],
      }),
    ).toEqual({
      court: undefined,
      courts: ["Najvyšší súd"],
      courtSpellings: ["Najvyšší súd"],
    });
  });

  test("a contradiction is sent as written", () => {
    expect(
      combineCourtFilters({ court: SUPREME, courts: ["Ústavný súd"] }),
    ).toEqual({
      court: "Najvyšší súd",
      courts: ["Ústavný súd"],
      courtSpellings: ["Najvyšší súd"],
    });
  });

  test("a list that read as nothing is no list", () => {
    expect(combineCourtFilters({ court: undefined, courts: [] })).toEqual({
      court: undefined,
      courts: undefined,
      courtSpellings: undefined,
    });
  });
});
