import { describe, expect, test } from "bun:test";

import {
  buildDecisionFacts,
  DECISION_FACT_KEYWORD_LIMIT,
  DECISION_FACT_KINDS,
  hasDecisionFacts,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";

describe("decision facts", () => {
  test("reads publisher metadata under its adapter keys", () => {
    const facts = buildDecisionFacts({
      decisionType: "rozsudek",
      metadata: {
        judge: " Svobodová Silvie, Mgr. Ing. ",
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
      judge: "Svobodová Silvie, Mgr. Ing.",
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
      metadata: {},
      source: null,
      sourceUrl: null,
    });

    const orderedKinds: string[] = [...DECISION_FACT_KINDS];
    expect(orderedKinds.sort()).toEqual(Object.keys(facts).sort());
  });

  test("a selection answers only for the facts it names", () => {
    const facts = buildDecisionFacts({
      decisionType: "rozsudek",
      metadata: { keywords: ["a"] },
      source: { name: "x" },
      sourceUrl: "https://example.org/decision",
    });

    // The inspector header takes the type and the source; its body must not
    // print them a second time, and says so by reporting nothing to draw.
    expect(hasDecisionFacts({ facts, kinds: ["decisionType", "source"] })).toBe(
      true,
    );
    expect(hasDecisionFacts({ facts, kinds: ["subject", "judge"] })).toBe(
      false,
    );
    expect(hasDecisionFacts({ facts, kinds: [] })).toBe(false);
  });

  test("caps keywords and refuses non-http sources", () => {
    const facts = buildDecisionFacts({
      decisionType: null,
      metadata: {
        keywords: Array.from({ length: 20 }, (_, i) => `k${String(i)}`),
      },
      source: { name: "x" },
      sourceUrl: "ftp://example.org/decision.pdf",
    });

    expect(facts.keywords).toHaveLength(DECISION_FACT_KEYWORD_LIMIT);
    expect(facts.source).toBeNull();
  });

  test("is empty without metadata or source", () => {
    expect(
      hasDecisionFacts({
        facts: buildDecisionFacts({
          decisionType: null,
          metadata: null,
          source: null,
          sourceUrl: null,
        }),
        kinds: DECISION_FACT_KINDS,
      }),
    ).toBe(false);
  });
});
