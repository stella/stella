import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import {
  DECISION_DOCKET_IDENTITY_FIXTURES,
  DOCKET_IDENTITY_FIXTURE_NUMBER_MAX,
  DOCKET_IDENTITY_PART_NUMERAL,
  docketReaderEntryArbitrary,
} from "@stll/api-contract/decision-docket-identity.fixtures";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import { assertProperty, propertyConfig } from "@stll/property-testing";

import { docketFamilyCitationKeys } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";

/**
 * The parser-to-index invariant: whatever spelling a reader types, the docket
 * family the query parser reads is keyed, by the function that writes the
 * stored `citation_key`, exactly as the docket the court filed. A second
 * normalisation on either side would let one of them drift, and the lookup
 * would silently miss the decision while the text index still ranked its
 * citers.
 */

const CZE = { grammar: DECISION_DOCKET_GRAMMARS.CZE } as const;

type Docket = {
  readonly senate: number;
  readonly registry: string;
  readonly number: number;
  readonly year: number;
};

const docketArbitrary: fc.Arbitrary<Docket> = fc.record({
  senate: fc.integer({ min: 1, max: 99 }),
  registry: fc.constantFrom(
    "Cdo",
    "Tdo",
    "Afs",
    "As",
    "Azs",
    "Ads",
    "Odo",
    "NSČR",
    "Cmo",
    "A",
  ),
  number: fc.integer({ min: 1, max: 99_999 }),
  year: fc.integer({ min: 1993, max: 2030 }),
});

/** The docket as the court files it, and so as ingestion stores it. */
const filed = ({ number, registry, senate, year }: Docket): string =>
  `${String(senate)} ${registry} ${String(number)}/${String(year)}`;

/** A reader's spelling of the docket, with or without a sheet after it. */
const readerSpelling = (docket: Docket) =>
  fc
    .record({
      prefix: fc.constantFrom("", "sp. zn. ", "č. j. ", "čj. ", "č. k. "),
      senateGap: fc.constantFrom(" ", "", " "),
      numberGap: fc.constantFrom(" ", ""),
      slash: fc.constantFrom("/", " / "),
      sheet: fc.option(fc.integer({ min: 1, max: 9999 }), { nil: null }),
      dash: fc.constantFrom("-", "–", "—", " - ", " – "),
      lower: fc.boolean(),
    })
    .map(
      ({ dash, lower, numberGap, prefix, senateGap, sheet, slash }) =>
        `${prefix}${String(docket.senate)}${senateGap}${lower ? docket.registry.toLowerCase() : docket.registry}${numberGap}${String(docket.number)}${slash}${String(docket.year)}${sheet === null ? "" : `${dash}${String(sheet)}`}`,
    );

/** The stored `citation_key` of a docket, which every docket here has. */
const keyOf = (docket: string): string =>
  citationKeyOf(docket) ?? panic(`No citation key for ${docket}`);

const familyOf = (entry: string) => {
  const intent = parseDecisionQuery(entry, CZE);
  return intent.type === "identifier" && intent.kind === "docket"
    ? intent
    : panic(`Not a docket: ${entry}`);
};

describe("the docket a query reads is keyed as the stored docket", () => {
  test("every reader spelling's family keys as the filed docket's citation key", () => {
    fc.assert(
      fc.property(
        docketArbitrary.chain((docket) =>
          readerSpelling(docket).map((entry) => ({ docket, entry })),
        ),
        ({ docket, entry }) => {
          const intent = familyOf(entry);
          const stored = keyOf(filed(docket));
          expect(docketFamilyCitationKeys(intent), entry).toContain(stored);
          expect(keyOf(intent.family), entry).toBe(stored);
        },
      ),
      propertyConfig(),
    );
  });

  test("a member stored with a part numeral is read under its file's keys", () => {
    // A publisher's document with no key of its own keeps its tail on the
    // stored docket (`6 Tdo 1/2021- I.`); its key differs from the file's,
    // and the lookup reads it all the same.
    fc.assert(
      fc.property(
        docketArbitrary,
        fc.constantFrom("- ", "-", " - ", " – ", "– ", "/", " / ", ", ", " ,"),
        fc.constantFrom("I", "II", "III", "IV", "IX", "XIV", "XXXIX"),
        fc.constantFrom("", "."),
        (docket, separator, numeral, dot) => {
          const stored = `${filed(docket)}${separator}${numeral}${dot}`;
          const key = keyOf(stored);
          expect(key).not.toBe(keyOf(filed(docket)));
          const bare = familyOf(filed(docket));
          expect(docketFamilyCitationKeys(bare), stored).toContain(key);
          // The stored spelling itself reads back as the same file.
          expect(familyOf(stored).family).toBe(filed(docket));
        },
      ),
      propertyConfig(),
    );
  });

  test("a member stored with its sheet is read under the key ingestion gave it", () => {
    // However the stored docket spaces the dash, its key is whatever the
    // ingest key function makes of it; the lookup's spellings for the same
    // printed sheet are keyed by that same function.
    fc.assert(
      fc.property(
        docketArbitrary,
        fc.integer({ min: 1, max: 9999 }),
        fc.constantFrom("-", " - ", " -", "- ", " – ", "–"),
        (docket, sheet, dash) => {
          const stored = `${filed(docket)}${dash}${String(sheet)}`;
          const intent = familyOf(`${filed(docket)}-${String(sheet)}`);
          expect(docketFamilyCitationKeys(intent), stored).toContain(
            keyOf(stored),
          );
        },
      ),
      propertyConfig(),
    );
  });

  test("a sheet the reference prints adds the full file number, and only that", () => {
    const intent = familyOf("č. j. 4 As 50/2012 - 33");
    const keys = docketFamilyCitationKeys(intent);
    expect(keys).toContain(keyOf("4 As 50/2012 - 33"));
    expect(keys).toContain(keyOf("4 As 50/2012"));
    expect(keys).not.toContain(keyOf("4 As 50/2012 - 3"));
    expect(keys).not.toContain(keyOf("4 As 50/2012 - 333"));
    // No other file's key is ever read.
    for (const other of ["4 As 50/2013", "4 As 5/2012", "14 As 50/2012"]) {
      expect(keys).not.toContain(keyOf(other));
    }
  });
});

test("a reader entry's family keys as the filed docket, and its part as the stored sibling", () => {
  // An entry with a part reads by the citation keys alone, never by the
  // case-file key, so its stored sibling is reached only when the family
  // keys exactly as the filed docket does.
  const part = DOCKET_IDENTITY_PART_NUMERAL;
  assertProperty(
    "a reader entry's family keys as the filed docket, and its part as the stored sibling",
    fc.property(
      docketReaderEntryArbitrary,
      ({ entry, filed: stored, jurisdiction, partSibling }) => {
        const grammar = DECISION_DOCKET_GRAMMARS[jurisdiction];
        const label = `${jurisdiction}: ${entry}`;
        const familyIn = (text: string) => {
          const intent = parseDecisionQuery(text, { grammar });
          return intent.type === "identifier" && intent.kind === "docket"
            ? intent
            : panic(`Not a docket: ${jurisdiction}: ${text}`);
        };
        expect(keyOf(familyIn(entry).family), label).toBe(keyOf(stored));
        const withPart = familyIn(`${entry} - ${part}.`);
        expect(keyOf(withPart.family), label).toBe(keyOf(stored));
        // Pinned both ways: a declared gap that closes has to be
        // redeclared, and an undeclared one fails.
        const reached = docketFamilyCitationKeys(withPart).includes(
          keyOf(`${stored} - ${part}.`),
        );
        switch (partSibling.type) {
          case "keyed":
            expect(reached, label).toBe(true);
            break;
          case "apart":
            expect(reached, `${label}: ${partSibling.reason}`).toBe(false);
            break;
          default: {
            partSibling satisfies never;
            panic("Unhandled part sibling declaration");
          }
        }
      },
    ),
    propertyConfig(),
  );
});

describe.each(
  Object.values(DECISION_DOCKET_GRAMMARS).map(
    ({ jurisdiction }) => jurisdiction,
  ),
)(
  "a %s docket is read under the keys its file is stored with",
  (jurisdiction) => {
    const grammar = DECISION_DOCKET_GRAMMARS[jurisdiction];
    const fixture = DECISION_DOCKET_IDENTITY_FIXTURES[jurisdiction];
    const { sheet } = fixture;
    const n = DOCKET_IDENTITY_FIXTURE_NUMBER_MAX;
    const docket = fixture.filed(n);
    const part = DOCKET_IDENTITY_PART_NUMERAL;

    const familyIn = (entry: string) => {
      const intent = parseDecisionQuery(entry, { grammar });
      return intent.type === "identifier" && intent.kind === "docket"
        ? intent
        : panic(`Not a ${jurisdiction} docket: ${entry}`);
    };

    test("the filed docket is read under its own citation key", () => {
      expect(docketFamilyCitationKeys(familyIn(docket))).toContain(
        keyOf(docket),
      );
    });

    test("every reader spelling is read under the filed docket's citation key", () => {
      for (const entry of fixture.readerSpellings(n)) {
        const intent = familyIn(entry);
        expect(docketFamilyCitationKeys(intent), entry).toContain(
          keyOf(docket),
        );
        expect(keyOf(intent.family), entry).toBe(keyOf(docket));
      }
    });

    test("a member stored with a part numeral is read under its file's keys", () => {
      const keys = docketFamilyCitationKeys(familyIn(docket));
      for (const separator of ["- ", " - ", "/", ", "]) {
        const stored = `${docket}${separator}${part}.`;
        expect(keyOf(stored), stored).not.toBe(keyOf(docket));
        expect(keys, stored).toContain(keyOf(stored));
      }
    });

    if (sheet.type === "supported") {
      test("a member stored with its sheet is read under its own key, and no other sheet's", () => {
        const keys = docketFamilyCitationKeys(
          familyIn(`${docket}-${sheet.held}`),
        );
        expect(keys).toContain(keyOf(docket));
        for (const dash of ["-", " - ", " – "]) {
          const stored = `${docket}${dash}${sheet.held}`;
          expect(keys, stored).toContain(keyOf(stored));
        }
        expect(keys).not.toContain(keyOf(`${docket} - ${sheet.unheld}`));
        expect(keys).not.toContain(keyOf(fixture.filed(n + 1)));
      });
    }
  },
);
