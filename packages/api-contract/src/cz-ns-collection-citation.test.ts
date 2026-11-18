import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  canonicalCzNsCollectionCitation,
  CZ_NS_COLLECTION_PARTS,
  czNsCollectionIdentifierValues,
  formatCzNsCollectionCitation,
  parseCzNsCollectionCitation,
} from "./cz-ns-collection-citation";
import {
  exactDecisionMatches,
  parseDecisionQuery,
} from "./decision-query-intent";
import { decisionReporterGrammarForJurisdiction } from "./decision-reporter-grammar";

describe("Supreme Court collection citations", () => {
  test("each spelling commentaries and the court use reads as its part, number and year", () => {
    const cases: [string, string][] = [
      ["R 9/1971", "R 9/1971"],
      ["R 9 / 1971", "R 9/1971"],
      ["Rc 45/2012", "Rc 45/2012"],
      ["Rc. 45/2012", "Rc 45/2012"],
      ["R 45/2012 civ.", "Rc 45/2012"],
      ["R 45/2012 obč.", "Rc 45/2012"],
      ["č. 45/2012 Sb. rozh. obč.", "Rc 45/2012"],
      ["45/2012 Sb. rozh. obč.", "Rc 45/2012"],
      // The truncated spelling the corpus citation extractor stores.
      ["č. 45/2012 Sb. rozh. ob", "Rc 45/2012"],
      ["Sb. rozh. obč. 45/2012", "Rc 45/2012"],
      ["Rt 17/1971", "Rt 17/1971"],
      ["R 17/1971 tr.", "Rt 17/1971"],
      ["č. 17/1971 Sb. rozh. tr.", "Rt 17/1971"],
      ["Sb. rozh. tr. č. 17/1971", "Rt 17/1971"],
      ["č. 9/1971 Sb. rozh.", "R 9/1971"],
      [
        "Sbírka soudních rozhodnutí a stanovisek, sešit 1/1971, č. 9",
        "R 9/1971",
      ],
      [
        "uveřejněný pod číslem 45/2012 Sbírky soudních rozhodnutí a stanovisek, části civilní",
        "Rc 45/2012",
      ],
      [
        "pod č. 30/2015 Sbírky soudních rozhodnutí a stanovisek, část trestní",
        "Rt 30/2015",
      ],
      [
        "Sbírka soudních rozhodnutí a stanovisek, část trestní, č. 30/2015",
        "Rt 30/2015",
      ],
    ];
    for (const [written, canonical] of cases) {
      expect({
        written,
        canonical: canonicalCzNsCollectionCitation(written),
      }).toEqual({
        written,
        canonical,
      });
    }
  });

  test("text that is not a collection citation is not claimed", () => {
    for (const text of [
      "6 Cz 90/70",
      "22 Cdo 1717/2000",
      "R 9/71",
      "R 0/1971",
      "R 9/1871",
      "č. 2018/2010 Sb. NSS",
      "234/2002 Sb.",
      "N 53/26 SbNU 73",
      "Rc 45/2012 tr.",
      "R 9/1971 vedle",
    ]) {
      expect({ text, read: parseCzNsCollectionCitation(text) }).toEqual({
        text,
        read: null,
      });
    }
  });

  test("an entry's stored citations read back as themselves, and the part-less one names it whatever its part", () => {
    assertProperty(
      "an entry's stored citations read back as themselves, and the part-less one names it whatever its part",
      fc.property(
        fc.constantFrom(...CZ_NS_COLLECTION_PARTS),
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1918, max: 2100 }),
        (part, number, year) => {
          const [own, partless] = czNsCollectionIdentifierValues({
            part,
            number,
            year,
          });
          expect(canonicalCzNsCollectionCitation(own)).toBe(own);
          expect(canonicalCzNsCollectionCitation(partless)).toBe(partless);
          expect(parseCzNsCollectionCitation(own)).toEqual({
            part,
            number,
            year,
          });
          expect(partless).toBe(
            formatCzNsCollectionCitation({ part: null, number, year }),
          );
        },
      ),
    );
  });

  test("in Czechia a collection citation is a reporter citation, matched only by the entry's stored citations", () => {
    const reporters = decisionReporterGrammarForJurisdiction("CZE");
    const civil = {
      caseNumber: "6 Cz 90/70",
      ecli: "ECLI:CZ:NS:1970:6.CZ.90.1970.1",
      identifiers: czNsCollectionIdentifierValues({
        part: "civil",
        number: 9,
        year: 1971,
      }).map((value) => ({ type: "reporter-citation", value })),
    };
    const criminal = {
      caseNumber: "4 Tz 26/70",
      ecli: null,
      identifiers: czNsCollectionIdentifierValues({
        part: "criminal",
        number: 9,
        year: 1971,
      }).map((value) => ({ type: "reporter-citation", value })),
    };
    const hits = [civil, criminal];

    const stated = parseDecisionQuery("č. 9/1971 Sb. rozh. obč.", {
      reporters,
    });
    expect(stated).toEqual({
      type: "identifier",
      kind: "reporter",
      value: "Rc 9/1971",
    });
    if (stated.type !== "identifier") {
      throw new Error("expected an identifier");
    }
    expect(exactDecisionMatches(stated, hits, { reporters })).toEqual([civil]);

    const partless = parseDecisionQuery("R 9/1971", { reporters });
    if (partless.type !== "identifier") {
      throw new Error("expected an identifier");
    }
    expect(exactDecisionMatches(partless, hits, { reporters })).toEqual(hits);

    // Without the Czech grammar the same entry is not a citation.
    expect(parseDecisionQuery("Rc 9/1971", { reporters: null })).not.toEqual(
      stated,
    );
  });
});
