import { describe, expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import {
  CITATION_RELATION_UNCERTAIN,
  CITATION_RELATIONS,
} from "@stll/api-contract/citation-check";
import type { CitationRelation } from "@stll/api-contract/citation-check";
import {
  DECISION_DOCKET_GRAMMARS,
  parseDecisionDocket,
} from "@stll/api-contract/decision-docket-grammar";

import {
  chooseCitedDecision,
  CITATION_RELATION_CRITERIA,
  readCitationRelation,
  readCitedDecision,
} from "@/api/handlers/case-law/citations/check.logic";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { NO_SOURCE } from "@/api/lib/workflow/decisions/answer-questions";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import type { ChoiceAnswer } from "@/api/lib/workflow/decisions/system-one";

/** Ids whose lexical order is the last tie-break, spelled so it is readable. */
const decisionId = (ordinal: string) =>
  toSafeId<"caseLawDecision">(`00000000-0000-7000-8000-00000000000${ordinal}`);

const decisionRow = (
  overrides: Partial<DecisionIdentityRow> & { id: SafeId<"caseLawDecision"> },
): DecisionIdentityRow => ({
  caseNumber: "21 Cdo 1234/2020",
  caseNumberType: "case-number",
  country: "CZE",
  court: "Nejvyšší soud",
  courtAbbreviation: null,
  decisionDate: "2020-06-01",
  decisionType: null,
  ecli: null,
  identifiers: [],
  language: "cs",
  languageAlternates: [],
  slug: null,
  ...overrides,
});

const czechValue = (
  reads: readonly { country: string; value: string }[],
): string | undefined => reads.find((read) => read.country === "CZE")?.value;

const docketValues = (citation: string) =>
  readCitedDecision(citation).map((read) => ({
    country: read.country,
    kind: read.intent.kind,
    value: read.intent.value,
  }));

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
      const reads = docketValues(citation);
      // The prefix names the register and the trailing group names a sheet of
      // the court file; neither is part of the docket, so every spelling above
      // has to reduce to the one identifier.
      // Each jurisdiction reads the docket in its own grammar; the Czech one
      // is the one this reference is written for.
      expect(reads.map((read) => read.kind)).not.toContain("ecli");
      expect(czechValue(reads)).toBe("21 Cdo 1234/2020");
    }
  });

  test("reads a Constitutional Court docket with or without the word before it", () => {
    // The shared reader finds a reference among a few words of prose, so the
    // decision type a brief prints before the docket does not hide it.
    for (const citation of [
      "sp. zn. I. ÚS 1234/20",
      "nález sp. zn. I. ÚS 1234/20",
    ]) {
      expect(czechValue(docketValues(citation))).toBe("I. ÚS 1234/20");
    }
  });

  test("reads an ECLI by the country its own second field names", () => {
    const reads = docketValues("ECLI:CZ:NS:2020:21.CDO.1234.2020.1");
    expect(reads.map((read) => [String(read.country), read.kind])).toEqual([
      ["CZE", "ecli"],
    ]);
  });

  test("declines a reference from a jurisdiction with no corpus here", () => {
    // France publishes ECLIs; this deployment holds no French decisions, so
    // the reference names nothing rather than being checked against a
    // neighbouring corpus.
    expect(readCitedDecision("ECLI:FR:CCASS:2019:AP00123")).toEqual([]);
  });

  test("declines prose that names no identifier", () => {
    expect(readCitedDecision("the Supreme Court held otherwise")).toEqual([]);
    expect(readCitedDecision("   ")).toEqual([]);
  });

  test("names only jurisdictions whose corpus this deployment admits", () => {
    const reads = readCitedDecision("21 Cdo 1234/2020");
    expect(reads.length).toBeGreaterThan(0);
    for (const { country } of reads) {
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

describe("shaping what the decision model answered", () => {
  const sources = [
    { id: "p1", text: "The court held that the limitation period runs anew." },
    { id: "p2", text: "The appellant argued otherwise." },
  ];
  const decided = (
    choice: CitationRelation,
    probability: number,
  ): Decision<ChoiceAnswer<CitationRelation>> => ({
    state: "decided",
    source: "decision-model",
    model: "jev-test",
    evidence: null,
    probability,
    confidence: probability,
    answer: {
      type: "choice",
      choice,
      probabilities: {
        supports: choice === "supports" ? probability : 0,
        contradicts: choice === "contradicts" ? probability : 0,
        does_not_address: choice === "does_not_address" ? probability : 0,
      },
      confidence: probability,
    },
  });
  const decidedWhere = (choice: string): Decision<ChoiceAnswer> => ({
    state: "decided",
    source: "decision-model",
    model: "jev-test",
    evidence: null,
    probability: 0.9,
    confidence: 0.9,
    answer: {
      type: "choice",
      choice,
      probabilities: { [choice]: 0.9 },
      confidence: 0.9,
    },
  });

  test("a decided reading keeps its relation and the passage it rests on", () => {
    const read = readCitationRelation({
      relation: decided("supports", 0.92),
      where: decidedWhere("p1"),
      sources,
    });
    expect(read).toEqual({
      type: "read",
      reading: {
        relation: "supports",
        probability: 0.92,
        confidence: 0.92,
        passage: { anchor: "p1", text: sources[0]?.text ?? "" },
      },
    });
  });

  test("an answer under the floor or a refusal is an uncertain reading", () => {
    for (const reason of ["below-floor", "refusal"] as const) {
      const read = readCitationRelation({
        relation: {
          state: "undecided",
          reason,
          confidence: reason === "below-floor" ? 0.4 : null,
          source: "decision-model",
          model: "jev-test",
        },
        where: decidedWhere("p1"),
        sources,
      });
      expect(read).toEqual({
        type: "read",
        reading: {
          relation: CITATION_RELATION_UNCERTAIN,
          probability: null,
          confidence: reason === "below-floor" ? 0.4 : null,
          passage: null,
        },
      });
    }
  });

  test("no model and a failed call are not readings", () => {
    const undecided = (reason: "no-backend" | "failed") =>
      readCitationRelation({
        relation: {
          state: "undecided",
          reason,
          confidence: null,
          source: "decision-model",
          model: null,
        },
        where: null,
        sources,
      });
    expect(undecided("no-backend")).toEqual({
      type: "failed",
      reason: "no_model",
    });
    expect(undecided("failed")).toEqual({ type: "failed", reason: "failed" });
  });

  test("a reading resting on no listed passage carries none", () => {
    for (const where of [decidedWhere(NO_SOURCE), null]) {
      const read = readCitationRelation({
        relation: decided("does_not_address", 0.95),
        where,
        sources,
      });
      expect(read.type === "read" ? read.reading.passage : "failed").toBeNull();
    }
  });

  test("a passage the request never offered is a transport bug, not a value", () => {
    expect(() =>
      readCitationRelation({
        relation: decided("supports", 0.9),
        where: decidedWhere("p9"),
        sources,
      }),
    ).toThrow("a passage the request did not offer");
  });
});

describe("the relation vocabulary", () => {
  test("every relation is written up for the lawyer reading the answer", () => {
    expect(Object.keys(CITATION_RELATION_CRITERIA).toSorted()).toEqual(
      [...CITATION_RELATIONS].toSorted(),
    );
  });
});
