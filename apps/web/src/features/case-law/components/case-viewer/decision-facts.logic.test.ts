import { describe, expect, test } from "bun:test";

import {
  buildDecisionFacts,
  DECISION_FACT_KEYWORD_LIMIT,
  DECISION_FACT_KINDS,
  hasDecisionFacts,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";
import type { DecisionJudge } from "@/features/case-law/decision-judges";
import { toSafeId } from "@/lib/safe-id";

const RAPPORTEUR = {
  judgeId: toSafeId<"caseLawJudge">("00000000-0000-4000-8000-000000000001"),
  name: "Nováková Jana",
  portrait: {
    attribution: "Ústavní soud",
    url: "/api/case-law/judges/00000000-0000-4000-8000-000000000001/portrait",
  },
  role: "rapporteur",
} as const satisfies DecisionJudge;

const DISSENTER = {
  judgeId: null,
  name: "Dvořák Petr",
  portrait: null,
  role: "dissenting",
} as const satisfies DecisionJudge;

describe("decision facts", () => {
  test("reads publisher metadata under its adapter keys", () => {
    const facts = buildDecisionFacts({
      decisionType: "rozsudek",
      judges: [],
      metadata: {
        legalArea: "Stavební zákon",
        legalAreas: ["Baurecht", 7, ""],
        keywords: ["a", "b"],
        subjectOfProceeding: "Územní řízení",
      },
      source: { name: "Czech Supreme Administrative Court" },
      sourceUrl: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/769038",
    });

    expect(facts).toEqual({
      decisionType: "rozsudek",
      judges: [],
      keywords: ["a", "b"],
      legalAreas: ["Stavební zákon", "Baurecht"],
      source: {
        name: "Czech Supreme Administrative Court",
        url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/769038",
      },
      subject: "Územní řízení",
    });
    expect(hasDecisionFacts({ facts, kinds: DECISION_FACT_KINDS })).toBe(true);
  });

  test("the reader's fact order covers every fact it can build", () => {
    const facts = buildDecisionFacts({
      decisionType: "rozsudek",
      judges: [],
      metadata: {},
      source: { name: "x" },
      sourceUrl: null,
    });

    const orderedKinds: string[] = [...DECISION_FACT_KINDS];
    expect(orderedKinds.toSorted()).toEqual(Object.keys(facts).toSorted());
  });

  test("a selection answers only for the facts it names", () => {
    const facts = buildDecisionFacts({
      decisionType: "rozsudek",
      judges: [],
      metadata: { keywords: ["a"] },
      source: { name: "x" },
      sourceUrl: "https://example.org/decision",
    });

    // The inspector header takes the type and the source; its body must not
    // print them a second time, and says so by reporting nothing to draw.
    expect(hasDecisionFacts({ facts, kinds: ["decisionType", "source"] })).toBe(
      true,
    );
    expect(hasDecisionFacts({ facts, kinds: ["subject", "judges"] })).toBe(
      false,
    );
    expect(hasDecisionFacts({ facts, kinds: [] })).toBe(false);
  });

  test("a bench the court named is a fact, and an empty one is not", () => {
    const withBench = buildDecisionFacts({
      decisionType: null,
      judges: [DISSENTER, RAPPORTEUR],
      metadata: {},
      source: { name: "x" },
      sourceUrl: null,
    });

    // Rapporteur first, whichever order the read sent them in.
    expect(withBench.judges.map((judge) => judge.name)).toEqual([
      RAPPORTEUR.name,
      DISSENTER.name,
    ]);
    expect(hasDecisionFacts({ facts: withBench, kinds: ["judges"] })).toBe(
      true,
    );

    const withoutBench = buildDecisionFacts({
      decisionType: null,
      judges: [],
      metadata: {},
      source: { name: "x" },
      sourceUrl: null,
    });
    expect(hasDecisionFacts({ facts: withoutBench, kinds: ["judges"] })).toBe(
      false,
    );
  });

  test("caps keywords and refuses non-http sources", () => {
    const facts = buildDecisionFacts({
      decisionType: null,
      judges: [],
      metadata: {
        keywords: Array.from({ length: 20 }, (_, i) => `k${String(i)}`),
      },
      source: { name: "x" },
      sourceUrl: "ftp://example.org/decision.pdf",
    });

    expect(facts.keywords).toHaveLength(DECISION_FACT_KEYWORD_LIMIT);
    expect(facts.source).toBeNull();
  });

  test("is empty without metadata, a bench or a source address", () => {
    expect(
      hasDecisionFacts({
        facts: buildDecisionFacts({
          decisionType: null,
          judges: [],
          metadata: {},
          source: { name: "x" },
          sourceUrl: null,
        }),
        kinds: DECISION_FACT_KINDS,
      }),
    ).toBe(false);
  });
});
