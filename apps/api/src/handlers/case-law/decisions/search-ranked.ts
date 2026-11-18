import { panic, Result } from "better-result";

import { FACET_COUNT_TYPE } from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { sha256Hex } from "@stll/sha256/bun";

import type {
  CorpusIndexClient,
  CorpusIndexQueryDsl,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexDecisionTerms } from "@/api/lib/legal-search/corpus-index-manifest";
import type { CaseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import {
  type CorpusProjectionRevision,
  type CorpusProjectionRevisionField,
  corpusRevisionClause,
} from "@/api/lib/legal-search/corpus-index-revision-clause";
import {
  type CorpusQueryToken,
  type CorpusTermExpander,
  partitionCorpusQueryTokens,
  quoteCorpusValue,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import type { CorpusIndexQueryVariant } from "@/api/lib/legal-search/corpus-query-variant-policy";
import {
  type DecisionRankingArm,
  rankedDecisionQuery,
  type RankedDecisionWord,
} from "@/api/lib/legal-search/corpus-ranked-decision-query";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { stemLegalTerm } from "@/api/lib/legal-search/morphology/stem";
import { LIMITS } from "@/api/lib/limits";

import {
  distinctRequiredTerms,
  type HitTerms,
  NO_HIT_TERMS,
  readTermCoverage,
  readTermDecisionCounts,
  type RelaxedTopUpOutcome,
  spelledTerm,
  type TermDecisionCounts,
} from "./search-relaxed";

/**
 * The decision-level search: on a generation that writes each decision's terms
 * on its opening passage, one ranked request orders decisions by how many of
 * the words their whole text holds and how rare those words are, instead of
 * requiring every word inside one passage and topping a short page up with a
 * second, bounded pass.
 *
 * What it asks of the engine (`corpus-ranked-decision-query.ts`): scope and
 * the opening passage in `filter`, one `should` clause per word, and
 * `minimum_should_match` from the arm. `strict` asks for every word anywhere
 * in the decision; otherwise every word is optional and more of them rank
 * higher. The authority and court blend then reads that order as it reads
 * any other.
 *
 * Not every query takes this path on such a generation, each for a stated
 * reason, and those keep the passage scan (without its partial pass):
 * - a quoted phrase: the decision field records no positions, so adjacency
 *   can only be read on the passages;
 * - a provision mention: it is matched through provision keys, not words;
 * - a date order: a ranking by date over optional words would rank by date
 *   decisions holding one common word;
 * - more distinct words than one search checks one by one.
 */

/** The arm a request without `strict` ranks with; the evaluation may move it. */
const CASE_LAW_RANKED_DEFAULT_ARM: DecisionRankingArm = "any";

/** Weight of a word in the publisher's keywords or headnote over the text. */
const CASE_LAW_RANKED_PUBLISHER_BOOST = 2;

/** On v11 every decision's terms sit on its opening passage, and only there. */
const OPENING_PASSAGE_CLAUSE = "is_opening:true";

type RankedSearchWord = {
  /** The word as `queryUsed` spells it. */
  term: string;
  leaves: RankedDecisionWord;
};

export type RankedSearchPlan = {
  arm: DecisionRankingArm;
  words: readonly RankedSearchWord[];
  /** The scored scan's request. */
  scanQuery: CorpusIndexQueryDsl;
  /** Decisions holding every word, as a query string: total and facets. */
  allWordsQuery: (scope: string) => string;
  /** Decisions holding one word, as a query string: coverage and counts. */
  wordQuery: (index: number, scope: string) => string;
  /** The scope the scan filtered by: opening passage plus the request's filters. */
  scope: string;
};

export type RankedSearchIneligible =
  | "not_a_decision_generation"
  | "date_order"
  | "phrase"
  | "provision_mention"
  | "too_many_words"
  | "no_words";

type RankedSearchShapeOptions = {
  decisionTerms: CorpusIndexDecisionTerms | null;
  text: string;
  sort: string;
  strict: boolean;
  functionWords: ReadonlySet<string> | null;
  queryVariant: CorpusIndexQueryVariant;
  jurisdiction: string | undefined;
};

/** A request the decision-level ranking answers, before its leaves are built. */
export type RankedSearchShape = {
  type: "ranked";
  arm: DecisionRankingArm;
  decisionTerms: CorpusIndexDecisionTerms;
  tokens: readonly CorpusQueryToken[];
};

/**
 * Whether a request takes the decision-level ranking, and with which arm, or
 * why it keeps the passage scan. Read before any engine work: the arm is part
 * of the cursor's identity. Pure, so a test pins each reason.
 */
export const rankedSearchShape = ({
  decisionTerms,
  text,
  sort,
  strict,
  functionWords,
  queryVariant,
  jurisdiction,
}: RankedSearchShapeOptions):
  RankedSearchShape | { type: "passages"; reason: RankedSearchIneligible } => {
  if (decisionTerms === null) {
    return { type: "passages", reason: "not_a_decision_generation" };
  }
  if (sort !== "relevance") {
    return { type: "passages", reason: "date_order" };
  }
  const { baseline, mentions } = partitionCorpusQueryTokens({
    tokens: tokenizeCorpusFreeText(text),
    functionWords,
    queryVariant,
    jurisdiction,
  });
  if (mentions.length > 0) {
    return { type: "passages", reason: "provision_mention" };
  }
  const tokens = distinctRequiredTerms(baseline.required);
  if (tokens.some((token) => token.type === "phrase")) {
    return { type: "passages", reason: "phrase" };
  }
  if (tokens.length === 0) {
    return { type: "passages", reason: "no_words" };
  }
  if (tokens.length > LIMITS.caseLawSearchTermCountsMax) {
    return { type: "passages", reason: "too_many_words" };
  }
  return {
    type: "ranked",
    arm: strict ? "all" : CASE_LAW_RANKED_DEFAULT_ARM,
    decisionTerms,
    tokens,
  };
};

/**
 * The read target a ranked request's cursor pins: the passage scan's target
 * plus the arm and the boost, so a cursor from another arm, or from before a
 * boost changed, is stale rather than a boundary in a different order.
 */
export const rankedCursorTarget = (
  target: string | null,
  shape: RankedSearchShape | { type: "passages" },
): string | null =>
  shape.type === "passages"
    ? target
    : sha256Hex(
        JSON.stringify([
          target,
          "decision-ranking",
          shape.arm,
          CASE_LAW_RANKED_PUBLISHER_BOOST,
        ]),
      ).slice(0, 32);

type PlanRankedSearchOptions = {
  fields: CaseLawCorpusQueryFields;
  legalAlternatives: CorpusTermExpander | null;
  /** The request's filters as engine clauses (`caseLawCorpusFilterClauses`). */
  filterClauses: readonly string[];
};
/** Distinct, non-empty leaves in first-seen order. */
const unique = (leaves: readonly string[]): string[] => [
  ...new Set(leaves.filter((leaf) => leaf.length > 0)),
];

/**
 * One word's leaves on the decision field: the form typed (which is what a
 * decision in a language with no stemmer holds) and its stem (what one with a
 * stemmer holds), and the same two for each single-word legal alternative. A
 * multi-word alternative is a phrase, which the field cannot answer; its words
 * stay with the passages. Publisher leaves name the word in the keywords as
 * typed and in the headnote's stems.
 */
const wordLeaves = (
  token: CorpusQueryToken,
  {
    decisionField,
    fields,
    legalAlternatives,
  }: {
    decisionField: string;
    fields: CaseLawCorpusQueryFields;
    legalAlternatives: CorpusTermExpander | null;
  },
): RankedDecisionWord => {
  const language = fields.stemming?.language ?? null;
  const forms = [
    token.value,
    ...(legalAlternatives === null
      ? []
      : legalAlternatives(token.value)
    ).filter((alternative) => corpusTokens(alternative).length === 1),
  ];
  const decisionLeaves = unique(
    forms.flatMap((form) => [
      `${decisionField}:${quoteCorpusValue(form)}`,
      ...(language === null
        ? []
        : [
            `${decisionField}:${quoteCorpusValue(stemLegalTerm(form, language))}`,
          ]),
    ]),
  );
  const headnoteStemField = fields.stemming?.fields.at(1);
  const boostedLeaves = unique([
    ...fields.keywordFields.map(
      (field) => `${field}:${quoteCorpusValue(token.value)}`,
    ),
    ...(language === null || headnoteStemField === undefined
      ? []
      : [
          `${headnoteStemField}:${quoteCorpusValue(stemLegalTerm(token.value, language))}`,
        ]),
  ]);
  return { decisionLeaves, boostedLeaves };
};

const orLeaves = ({ decisionLeaves, boostedLeaves }: RankedDecisionWord) =>
  `(${[...decisionLeaves, ...boostedLeaves].join(" OR ")})`;

const scoped = (scope: string, clause: string) =>
  `(${OPENING_PASSAGE_CLAUSE}) AND ${scope === "" ? "" : `(${scope}) AND `}${clause}`;

/** The requests a ranked search sends, built from its shape. */
export const planRankedSearch = (
  { arm, decisionTerms, tokens }: RankedSearchShape,
  { fields, legalAlternatives, filterClauses }: PlanRankedSearchOptions,
): RankedSearchPlan => {
  const words = tokens.map((token) => ({
    term: spelledTerm(token),
    leaves: wordLeaves(token, {
      decisionField: decisionTerms.field,
      fields,
      legalAlternatives,
    }),
  }));
  const scope = filterClauses.join(" AND ");
  return {
    arm,
    words,
    scope,
    scanQuery: {
      type: "dsl",
      query: rankedDecisionQuery({
        scope:
          scope === ""
            ? OPENING_PASSAGE_CLAUSE
            : `${OPENING_PASSAGE_CLAUSE} AND ${scope}`,
        words: words.map(({ leaves }) => leaves),
        arm,
        boost: CASE_LAW_RANKED_PUBLISHER_BOOST,
      }),
    },
    allWordsQuery: (facetScope) =>
      scoped(
        facetScope,
        `(${words.map(({ leaves }) => orLeaves(leaves)).join(" AND ")})`,
      ),
    wordQuery: (index, wordScope) => {
      const word = words.at(index);
      if (word === undefined) {
        return panic(`No ranked word at ${String(index)}`);
      }
      return scoped(wordScope, orLeaves(word.leaves));
    },
  };
};

type ReadRankedPageWordsOptions = {
  aggregate: CorpusIndexClient["aggregate"];
  observer: RegistryRequestObservation;
  signal?: AbortSignal | undefined;
  indexId: string;
  plan: RankedSearchPlan;
  revisionField: CorpusProjectionRevisionField;
  /** The copy of each decision the page was read from. */
  appliedRevisionOf: (id: string) => CorpusProjectionRevision;
  ids: readonly string[];
};

/**
 * Which of the words each decision on a ranked page holds, read off the
 * decision field in the copy the page shows: for each id, the indexes of the
 * plan's words it holds. Bounded by the page, one aggregation per word.
 */
export const readRankedPageWords = async ({
  aggregate,
  observer,
  signal,
  indexId,
  plan,
  revisionField,
  appliedRevisionOf,
  ids,
}: ReadRankedPageWordsOptions): Promise<
  ReadonlyMap<string, ReadonlySet<number>>
> => {
  if (ids.length === 0) {
    return new Map();
  }
  const copies = ids
    .map((id) =>
      corpusRevisionClause({
        clause: `document_id:${quoteCorpusValue(id)}`,
        field: revisionField,
        revision: appliedRevisionOf(id),
      }),
    )
    .join(" OR ");
  const held = await readTermCoverage({
    aggregate,
    observer,
    signal,
    indexId,
    ids,
    queries: plan.words.map(
      (_, index) => `(${plan.wordQuery(index, "")}) AND (${copies})`,
    ),
  });
  if (Result.isError(held)) {
    // A ranked page states every hit's words, so a failed read fails the
    // page the way the scan's engine failures do today: the scan throws its
    // HandlerError (`corpusIndexSearchFailure`) and the HTTP core answers
    // it. Counted by the throw ratchet and funded by
    // scripts/ratchet-allowances/case-law-ranked-page-words-throw.json.
    throw held.error;
  }
  return held.value;
};

type RankedHitTermsOptions = {
  plan: RankedSearchPlan;
  held: ReadonlyMap<string, ReadonlySet<number>>;
  /** Decisions an identifier named, which the words did not select. */
  pinnedIds: ReadonlySet<string>;
};

/** Each ranked hit's words: those its decision holds and those it lacks. */
export const rankedHitTerms =
  ({ plan, held, pinnedIds }: RankedHitTermsOptions) =>
  (id: string): HitTerms => {
    if (pinnedIds.has(id)) {
      return NO_HIT_TERMS;
    }
    const words = held.get(id) ?? panic("Ranked hit has no word read");
    return {
      matchedTerms: plan.words
        .filter((_, index) => words.has(index))
        .map(({ term }) => term),
      missingTerms: plan.words
        .filter((_, index) => !words.has(index))
        .map(({ term }) => term),
    };
  };

/**
 * A ranked hit is a full match when its decision holds every word, wherever
 * in its text, and partial when it lacks one.
 */
export const rankedMatch = (hit: {
  missingTerms: readonly string[];
}): "all_terms" | "some_terms" =>
  hit.missingTerms.length === 0 ? "all_terms" : "some_terms";

type ReadRankedTermDecisionCountsOptions = Omit<
  Parameters<typeof readTermDecisionCounts>[0],
  "queries"
> & {
  plan: RankedSearchPlan;
  /** The page size: fewer decisions than this holding every word is "few". */
  limit: number;
};

/**
 * On a ranked first page: how many decisions hold every word, and when fewer
 * than a page do, how many hold each word on its own. Null when enough hold
 * them all for the page to need no explanation.
 */
export const readRankedTermDecisionCounts = async ({
  plan,
  limit,
  ...read
}: ReadRankedTermDecisionCountsOptions): Promise<
  Result<TermDecisionCounts | null, unknown>
> => {
  const all = await readTermDecisionCounts({
    ...read,
    queries: [plan.allWordsQuery(plan.scope)],
  });
  if (Result.isError(all)) {
    return all;
  }
  const allTerms = all.value.at(0) ?? panic("Missing all-word count");
  if (allTerms >= limit) {
    return Result.ok(null);
  }
  const perWord = await readTermDecisionCounts({
    ...read,
    queries: plan.words.map((_, index) => plan.wordQuery(index, plan.scope)),
  });
  return perWord.map((values) => ({
    allTerms,
    terms: plan.words.map(({ term }, index) => ({
      term,
      count: values[index] ?? panic("Missing term decision count"),
    })),
    countType: FACET_COUNT_TYPE.ESTIMATE,
  }));
};

/** The counts' outcome in the shape the partial-pass steps settle in. */
export const rankedCountsOutcome = (
  read: Result<TermDecisionCounts | null, unknown>,
): RelaxedTopUpOutcome<TermDecisionCounts> | null => {
  if (Result.isError(read)) {
    return { type: "skipped", error: read.error };
  }
  return read.value === null ? null : { type: "read", value: read.value };
};
