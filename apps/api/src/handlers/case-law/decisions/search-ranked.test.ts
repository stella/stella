import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexDecisionTerms,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import { stemLegalTerm } from "@/api/lib/legal-search/morphology/stem";
import {
  PUBLIC_READ_TIMEOUT_CODE,
  publicReadTimeoutRefusal,
} from "@/api/lib/legal-search/public-read-timeout";
import { SEARCH_INDEX_UNAVAILABLE_CODE } from "@/api/lib/legal-search/search-index-unavailable";
import { LIMITS } from "@/api/lib/limits";

import { aggregationsApplyEveryFilter } from "./search";
import {
  pageWordsRefusal,
  planRankedSearch,
  rankedCursorTarget,
  rankedSearchShape,
} from "./search-ranked";

const V11 = corpusIndexDecisionTerms(CORPUS_INDEX_MANIFESTS.case_law_v11);
const V7 = corpusIndexDecisionTerms(CORPUS_INDEX_MANIFESTS.case_law_v7);

const shapeOf = (overrides: Partial<Parameters<typeof rankedSearchShape>[0]>) =>
  rankedSearchShape({
    decisionTerms: V11,
    text: "loajalita jednatel ušlý zisk",
    sort: "relevance",
    strict: false,
    functionWords: null,
    queryVariant: "off",
    jurisdiction: "CZE",
    ...overrides,
  });

describe("which requests rank whole decisions", () => {
  test("a relevance search on a generation with the decision field does", () => {
    expect(shapeOf({})).toMatchObject({ type: "ranked", arm: "any" });
    expect(shapeOf({ strict: true })).toMatchObject({
      type: "ranked",
      arm: "all",
    });
  });

  test("a caller comparing arms sets the unstrict arm; strict still means every word", () => {
    expect(shapeOf({ unstrictArm: "half" })).toMatchObject({
      type: "ranked",
      arm: "half",
    });
    expect(shapeOf({ unstrictArm: "half", strict: true })).toMatchObject({
      type: "ranked",
      arm: "all",
    });
  });

  test.each([
    [
      "a passage generation",
      { decisionTerms: V7 },
      "not_a_decision_generation",
    ],
    ["a date order", { sort: "newest" }, "date_order"],
    ["a quoted phrase", { text: '"ušlý zisk" jednatel' }, "phrase"],
    [
      "more words than one search checks",
      {
        text: Array.from(
          { length: LIMITS.caseLawSearchTermCountsMax + 1 },
          (_, index) => `slovo${String(index)}`,
        ).join(" "),
      },
      "too_many_words",
    ],
  ] as const)("%s keeps the passage scan", (_name, overrides, reason) => {
    expect(shapeOf(overrides)).toEqual({ type: "passages", reason });
  });

  test("the arm is part of the cursor's identity", () => {
    const any = shapeOf({});
    const all = shapeOf({ strict: true });
    expect(rankedCursorTarget("target", any)).not.toBe(
      rankedCursorTarget("target", all),
    );
    expect(rankedCursorTarget("target", { type: "passages" })).toBe("target");
    expect(rankedCursorTarget("target", any)).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe("the ranked plan", () => {
  const shaped = shapeOf({});
  const shape =
    shaped.type === "ranked" ? shaped : panic("expected a ranked shape");
  const plan = planRankedSearch(shape, {
    fields: caseLawCorpusQueryFields({
      generation: "case_law_v11",
      jurisdiction: "CZE",
      language: undefined,
    }),
    legalAlternatives: (term) =>
      term === "jednatel" ? ["statutár", "člen orgánu"] : [],
    filterClauses: ['court:"Nejvyšší soud"'],
  });

  test("each word reaches the decision field typed and stemmed, and a one-word alternative too", () => {
    const leaves = plan.words.at(1)?.leaves.decisionLeaves ?? [];
    expect(leaves).toContain('decision_terms:"jednatel"');
    expect(leaves).toContain(
      `decision_terms:"${stemLegalTerm("jednatel", "cs")}"`,
    );
    expect(leaves).toContain('decision_terms:"statutár"');
    // A phrase alternative is not a word the positionless field can answer.
    expect(leaves.some((leaf) => leaf.includes("člen orgánu"))).toBe(false);
  });

  test("scope filters the scan, and the words are its should clauses", () => {
    const sent = JSON.stringify(plan.scanQuery.query);
    expect(plan.scanQuery.query).toMatchObject({
      bool: { minimum_should_match: 1 },
    });
    const { bool } = v.parse(
      v.object({
        bool: v.object({
          filter: v.array(v.unknown()),
          should: v.array(v.unknown()),
        }),
      }),
      plan.scanQuery.query,
    );
    expect(JSON.stringify(bool.filter)).toContain("is_opening:true");
    expect(JSON.stringify(bool.filter)).toContain("Nejvyšší soud");
    expect(bool.should).toHaveLength(plan.words.length);
    expect(sent).not.toContain("undefined");
  });

  test("the all-word query requires each word on the opening passage", () => {
    const query = plan.allWordsQuery(plan.scope);
    expect(query.startsWith("(is_opening:true) AND (")).toBe(true);
    expect(query.split(" AND (").length).toBeGreaterThan(plan.words.length);
    expect(plan.wordQuery(0, "")).toBe(
      `(is_opening:true) AND (${[
        ...(plan.words.at(0)?.leaves.decisionLeaves ?? []),
        ...(plan.words.at(0)?.leaves.boostedLeaves ?? []),
      ].join(" OR ")})`,
    );
  });
});

describe("a ranked plan with no language to stem under", () => {
  const planFor = (
    text: string,
    jurisdiction: string | undefined,
    language: string | undefined = undefined,
  ) => {
    const shaped = shapeOf({ text, jurisdiction });
    const shape =
      shaped.type === "ranked" ? shaped : panic("expected a ranked shape");
    return planRankedSearch(shape, {
      fields: caseLawCorpusQueryFields({
        generation: "case_law_v11",
        jurisdiction,
        language,
      }),
      legalAlternatives: null,
      filterClauses: [],
    });
  };
  const leavesOf = (plan: ReturnType<typeof planFor>) =>
    plan.words.at(0)?.leaves.decisionLeaves ?? [];

  test.each([
    ["an unscoped search", "abandoning", undefined, "en"],
    ["an unscoped search", "loajality", undefined, "cs"],
    ["a European search without a language", "abandoning", "EU", "en"],
    ["a European search without a language", "loajality", "EU", "cs"],
  ] as const)(
    "%s asks the decision field for %s under the stemmer its documents used",
    (_name, word, jurisdiction, language) => {
      const leaves = leavesOf(planFor(word, jurisdiction));
      expect(leaves).toContain(`decision_terms:"${word}"`);
      expect(leaves).toContain(
        `decision_terms:"${stemLegalTerm(word, language)}"`,
      );
      expect(stemLegalTerm(word, language)).not.toBe(word);
    },
  );

  test("the headnote is asked in the same stems", () => {
    const plan = planFor("abandoning", undefined);
    expect(plan.words.at(0)?.leaves.boostedLeaves).toContain(
      `headnote_stem:"${stemLegalTerm("abandoning", "en")}"`,
    );
  });

  test("a scoped or language-filtered search keeps its one stemmer", () => {
    expect(leavesOf(planFor("loajality", "CZE"))).toEqual([
      'decision_terms:"loajality"',
      `decision_terms:"${stemLegalTerm("loajality", "cs")}"`,
    ]);
    expect(leavesOf(planFor("abandoning", "EU", "en"))).toEqual([
      'decision_terms:"abandoning"',
      `decision_terms:"${stemLegalTerm("abandoning", "en")}"`,
    ]);
  });
});

describe("a ranked page whose words could not be read", () => {
  test("answers a budget-ended read as the public-read timeout the tools continue", () => {
    const answer = pageWordsRefusal(
      publicReadTimeoutRefusal(new Error("budget")),
    );
    expect(answer.code).toBe(503);
    expect(answer.response).toMatchObject({
      code: PUBLIC_READ_TIMEOUT_CODE,
      retryable: true,
    });
  });

  test("answers any other failure as the index being unavailable, never a page without its words", () => {
    const answer = pageWordsRefusal(
      new HandlerError({
        status: 502,
        code: "internal_error",
        message: "Search term coverage is invalid",
      }),
    );
    expect(answer.code).toBe(503);
    expect(answer.response).toMatchObject({
      code: SEARCH_INDEX_UNAVAILABLE_CODE,
    });
  });
});

describe("which counts the engine may take", () => {
  const body = { country: "CZE", query: "nájem kauce" } as const;

  test("a request filtered only by corpus fields is counted", () => {
    expect(aggregationsApplyEveryFilter({ ...body, court: "NS" })).toBe(true);
  });

  test("a filter only the rows apply is not", () => {
    // Category, legal sentence, docket registers, senate: each is decided per
    // row, so an engine count under the request would count past it.
    expect(aggregationsApplyEveryFilter({ ...body, category: "civil" })).toBe(
      false,
    );
    expect(
      aggregationsApplyEveryFilter({ ...body, hasLegalSentence: true }),
    ).toBe(false);
    expect(
      aggregationsApplyEveryFilter({ ...body, docketRegisters: ["Cdo"] }),
    ).toBe(false);
    expect(aggregationsApplyEveryFilter({ ...body, senate: 29 })).toBe(false);
  });
});
