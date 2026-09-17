import { describe, expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import {
  CITATION_RELATIONS,
  CITATION_RELATION_UNCERTAIN,
} from "@stll/api-contract/citation-check";
import type { CitationRelation } from "@stll/api-contract/citation-check";
import {
  DECISION_DOCKET_GRAMMARS,
  parseDecisionDocket,
} from "@stll/api-contract/decision-docket-grammar";

import {
  CITATION_RELATION_CRITERIA,
  chooseCitedDecision,
  readCitationRelation,
  readCitedDecision,
} from "@/api/handlers/case-law/citations/check.logic";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  NO_SOURCE,
  SYSTEM_ONE_ACCEPT_CONFIDENCE,
} from "@/api/lib/typesafe/answer-questions";

/** Ids whose lexical order is the last tie-break, spelled so it is readable. */
const decisionId = (ordinal: string) =>
  toSafeId<"caseLawDecision">(`00000000-0000-7000-8000-00000000000${ordinal}`);

const decisionRow = (
  overrides: Partial<DecisionIdentityRow> & { id: SafeId<"caseLawDecision"> },
): DecisionIdentityRow => ({
  caseNumber: "21 Cdo 1234/2020",
  country: "CZE",
  court: "Nejvyšší soud",
  decisionDate: "2020-06-01",
  ecli: null,
  identifiers: [],
  language: "cs",
  slug: null,
  ...overrides,
});

describe("reading a decision reference out of prose", () => {
  test("reads the Czech spellings a judgment and a brief actually print", () => {
    for (const citation of [
      "sp. zn. 21 Cdo 1234/2020",
      "sp.zn. 21 Cdo 1234/2020",
      "21 Cdo 1234/2020",
      "  21 Cdo 1234/2020  ",
      "č. j. 21 Cdo 1234/2020-130",
      "čj. 21 Cdo 1234/2020 - 130",
    ]) {
      const read = readCitedDecision(citation);
      expect(read?.kind).toBe("docket");
      // The prefix names the register and the trailing group names a sheet of
      // the court file; neither is part of the docket, so every spelling above
      // has to reduce to the one identifier.
      expect(read?.identifier).toBe("21 Cdo 1234/2020");
      expect(read?.countries.map(String)).toContain("CZE");
    }
  });

  test("reads a Constitutional Court docket with its senate numeral", () => {
    const read = readCitedDecision("nález sp. zn. I. ÚS 1234/20");
    // "nález" is not a prefix the register list claims, so the whole string is
    // not a docket; the reference alone is.
    expect(read).toBeNull();
    expect(readCitedDecision("sp. zn. I. ÚS 1234/20")?.identifier).toBe(
      "I. ÚS 1234/20",
    );
  });

  test("reads an ECLI by the country its own second field names", () => {
    const read = readCitedDecision("ECLI:CZ:NS:2020:21.CDO.1234.2020.1");
    expect(read?.kind).toBe("ecli");
    expect(read?.countries.map(String)).toEqual(["CZE"]);
  });

  test("declines a reference from a jurisdiction with no corpus here", () => {
    // France publishes ECLIs; this deployment holds no French decisions, so
    // the reference names nothing rather than being checked against a
    // neighbouring corpus.
    expect(readCitedDecision("ECLI:FR:CCASS:2019:AP00123")).toBeNull();
  });

  test("declines prose that names no identifier", () => {
    expect(readCitedDecision("the Supreme Court held otherwise")).toBeNull();
    expect(readCitedDecision("   ")).toBeNull();
  });

  test("names only jurisdictions whose corpus this deployment admits", () => {
    const read = readCitedDecision("21 Cdo 1234/2020");
    expect(read?.countries.length).toBeGreaterThan(0);
    for (const country of read?.countries ?? []) {
      expect(PUBLIC_CASE_LAW_COUNTRIES).toContain(country);
    }
  });

  test("a bare docket is well-formed in more than one declared grammar", () => {
    // This is why the reader hands the lookup every jurisdiction that claims
    // a docket instead of taking the first grammar that accepts it:
    // `30 Cdo 3130/2021` parses in the Czech grammar and in the Slovak one,
    // so grammar order would silently decide which corpus answers a citation.
    const claiming = CASE_LAW_JURISDICTIONS.filter(
      (jurisdiction) =>
        parseDecisionDocket("30 Cdo 3130/2021", {
          grammar: DECISION_DOCKET_GRAMMARS[jurisdiction],
        }) !== null,
    );
    expect(claiming.length).toBeGreaterThan(1);
  });
});

describe("choosing between the decisions a reference resolves to", () => {
  test("checks the most recent and lists the rest", () => {
    const chosen = chooseCitedDecision([
      decisionRow({ id: decisionId("b"), decisionDate: "2019-01-01" }),
      decisionRow({ id: decisionId("c"), decisionDate: "2021-03-04" }),
      decisionRow({ id: decisionId("a"), decisionDate: "2020-06-01" }),
    ]);
    expect(chosen?.chosen.id).toBe(decisionId("c"));
    expect(chosen?.alternatives.map((row) => row.id)).toEqual([
      decisionId("a"),
      decisionId("b"),
    ]);
  });

  test("a decision with no date cannot pass for the most recent", () => {
    const undated = decisionId("1");
    const dated = decisionId("2");
    const chosen = chooseCitedDecision([
      decisionRow({ id: undated, decisionDate: null }),
      decisionRow({ id: dated, decisionDate: "1998-02-02" }),
    ]);
    expect(chosen?.chosen.id).toBe(dated);
    expect(chosen?.alternatives.map((row) => row.id)).toEqual([undated]);
  });

  test("orders equally dated decisions the same way twice", () => {
    const rows = [
      decisionRow({ id: decisionId("f"), decisionDate: "2020-01-01" }),
      decisionRow({ id: decisionId("a"), decisionDate: "2020-01-01" }),
    ];
    expect(chooseCitedDecision(rows)?.chosen.id).toBe(decisionId("a"));
    expect(chooseCitedDecision(rows.toReversed())?.chosen.id).toBe(
      decisionId("a"),
    );
  });

  test("no match is no choice", () => {
    expect(chooseCitedDecision([])).toBeNull();
  });
});

describe("shaping what the model answered", () => {
  const sources = [
    { id: "p1", text: "Nárok se promlčuje v obecné tříleté lhůtě." },
    { id: "p2", text: "Dovolání se zamítá." },
  ];
  const distribution = (
    chosen: CitationRelation,
    top: number,
  ): Record<CitationRelation, number> => ({
    supports: 0,
    contradicts: 0,
    does_not_address: 0,
    ...Object.fromEntries(
      CITATION_RELATIONS.map((relation) => [
        relation,
        relation === chosen ? top : (1 - top) / (CITATION_RELATIONS.length - 1),
      ]),
    ),
  });

  test("a confident reading keeps its relation and the passage it rests on", () => {
    const reading = readCitationRelation({
      relation: {
        choice: "supports",
        probabilities: distribution("supports", 0.86),
        confidence: 0.9,
      },
      where: "p1",
      sources,
    });
    expect(reading.relation).toBe("supports");
    expect(reading.probability).toBeCloseTo(0.86);
    expect(reading.passage).toEqual({ anchor: "p1", text: sources[0]!.text });
  });

  test("below the acceptance floor the relation is uncertain and the distribution survives", () => {
    const probabilities = distribution("contradicts", 0.45);
    const reading = readCitationRelation({
      relation: {
        choice: "contradicts",
        probabilities,
        confidence: SYSTEM_ONE_ACCEPT_CONFIDENCE - 0.01,
      },
      where: "p2",
      sources,
    });
    expect(reading.relation).toBe(CITATION_RELATION_UNCERTAIN);
    // The reading a reader would have been given is still there to weigh.
    expect(reading.probabilities).toEqual(probabilities);
    expect(reading.probability).toBeCloseTo(0.45);
  });

  test("the floor is the floor, not one step below it", () => {
    const reading = readCitationRelation({
      relation: {
        choice: "supports",
        probabilities: distribution("supports", 0.7),
        confidence: SYSTEM_ONE_ACCEPT_CONFIDENCE,
      },
      where: NO_SOURCE,
      sources,
    });
    expect(reading.relation).toBe("supports");
  });

  test("a reading resting on no listed passage carries none", () => {
    expect(
      readCitationRelation({
        relation: {
          choice: "does_not_address",
          probabilities: distribution("does_not_address", 0.95),
          confidence: 0.95,
        },
        where: NO_SOURCE,
        sources,
      }).passage,
    ).toBeNull();
  });

  test("a passage the request never offered is a transport bug, not a value", () => {
    expect(() =>
      readCitationRelation({
        relation: {
          choice: "supports",
          probabilities: distribution("supports", 0.9),
          confidence: 0.9,
        },
        where: "p9",
        sources,
      }),
    ).toThrow("Jev chose a passage the request did not offer");
  });
});

describe("the relation vocabulary", () => {
  test("every relation is written up for the lawyer reading the answer", () => {
    expect(Object.keys(CITATION_RELATION_CRITERIA).toSorted()).toEqual(
      [...CITATION_RELATIONS].toSorted(),
    );
  });
});
