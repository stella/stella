import { panic, Result } from "better-result";

import { FACET_COUNT_TYPE } from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { corpusTokens } from "@stll/legal-morphology/corpus-tokens";
import { queryStems } from "@stll/legal-morphology/stem";
import { sha256Hex } from "@stll/sha256/bun";

import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  CorpusIndexClient,
  CorpusIndexQueryDsl,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexDecisionTerms } from "@/api/lib/legal-search/corpus-index-manifest";
import type { CaseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import type {
  CorpusProjectionRevision,
  CorpusProjectionRevisionField,
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
import {
  PUBLIC_READ_TIMEOUT_CODE,
  publicReadTimeoutError,
  publicReadTimeoutResponse,
} from "@/api/lib/legal-search/public-read-timeout";
import { searchIndexUnavailableResponse } from "@/api/lib/legal-search/search-index-unavailable";
import { LIMITS } from "@/api/lib/limits";
import type { BoundedRequestStep } from "@/api/lib/load/request-latency-budget";
import { failureSink } from "@/api/lib/observability/failure";

import {
  distinctRequiredTerms,
  type HitTerms,
  NO_HIT_TERMS,
  readTermDecisionCounts,
  readWordsAtCopies,
  type RelaxedTopUpOutcome,
  relaxedTopUpOutcome,
  spelledTerm,
  type TermDecisionCounts,
  wordsHeldAt,
  type WordsRead,
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
  /**
   * The word on any passage, typed and stemmed: what a decision whose
   * decision field is a cut prefix is read from instead.
   */
  passageLeaves: readonly string[];
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
  /** Opening passages whose decision field holds only a prefix of the terms. */
  partialQuery: string;
  /** Passages holding one word, for decisions whose decision field is cut. */
  passageWordQuery: (index: number) => string;
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
  /**
   * The arm a request without `strict` ranks with, when a caller measuring
   * the arms sets it; the public routes leave it to the default.
   */
  unstrictArm?: DecisionRankingArm | undefined;
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
  unstrictArm = CASE_LAW_RANKED_DEFAULT_ARM,
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
    arm: strict ? "all" : unstrictArm,
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
 * decision in a language with no stemmer holds) and its stems under every
 * stemmer the searched documents were written with (what each of those
 * holds), and the same for each single-word legal alternative. A multi-word
 * alternative is a phrase, which the field cannot answer; its words stay
 * with the passages. Publisher leaves name the word in the keywords and the
 * headnote as typed and in the headnote's stems.
 *
 * The stems are `queryStems`: the typed form's own stem, plus what the same
 * algorithm with folded tables makes of it, because the index holds folded
 * stems of accented text and a reader who left the diacritics out
 * (`najemniho`) would otherwise ask for a stem no document holds
 * (`najemnih` beside the indexed `najemn`).
 *
 * The typed form also goes to the opening passage's surface text, bare, as
 * the passage scan sends it: the engine folds that text, so a word typed
 * without its diacritics still matches the decision's title and opening
 * exactly as typed, whatever its stem.
 *
 * The stemmers are the searched documents' (`documentStems`), never the one
 * language the reader is taken to write in: a search with no language (no
 * country, or the European index without a language filter) has none, yet
 * each of its documents holds only its own language's stems, so a typed form
 * alone would miss every inflection.
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
  const stems = fields.documentStems;
  const stemmed = (form: string): readonly string[] =>
    stems === null ? [] : queryStems(form, stems.languages);
  const forms = [
    token.value,
    ...(legalAlternatives === null
      ? []
      : legalAlternatives(token.value)
    ).filter((alternative) => corpusTokens(alternative).length === 1),
  ];
  const decisionLeaves = unique(
    forms.flatMap((form) => [
      ...[form, ...stemmed(form)].map(
        (term) => `${decisionField}:${quoteCorpusValue(term)}`,
      ),
      quoteCorpusValue(form),
    ]),
  );
  const boostedLeaves = unique([
    ...[...fields.keywordFields, ...fields.surfaceFields].map(
      (field) => `${field}:${quoteCorpusValue(token.value)}`,
    ),
    ...(stems === null
      ? []
      : stemmed(token.value).map(
          (stem) => `${stems.headnoteField}:${quoteCorpusValue(stem)}`,
        )),
  ]);
  return { decisionLeaves, boostedLeaves };
};

/**
 * One word's leaves on the passages: the forms typed, on the surface text a
 * bare term reaches, and their stems (`queryStems`, as on the decision field)
 * on each passage's stem field under every stemmer the searched documents
 * were written with. The passages of a decision hold all its text whatever
 * happened to its decision field.
 */
const passageWordLeaves = (
  token: CorpusQueryToken,
  {
    fields,
    legalAlternatives,
  }: {
    fields: CaseLawCorpusQueryFields;
    legalAlternatives: CorpusTermExpander | null;
  },
): string[] => {
  const stems = fields.documentStems;
  const forms = [
    token.value,
    ...(legalAlternatives === null
      ? []
      : legalAlternatives(token.value)
    ).filter((alternative) => corpusTokens(alternative).length === 1),
  ];
  return unique(
    forms.flatMap((form) => [
      quoteCorpusValue(form),
      ...(stems === null
        ? []
        : queryStems(form, stems.languages).map(
            (stem) => `${stems.textField}:${quoteCorpusValue(stem)}`,
          )),
    ]),
  );
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
    passageLeaves: passageWordLeaves(token, { fields, legalAlternatives }),
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
    partialQuery: `${OPENING_PASSAGE_CLAUSE} AND ${decisionTerms.partialField}:true`,
    passageWordQuery: (index) => {
      const word = words.at(index);
      if (word === undefined) {
        return panic(`No ranked word at ${String(index)}`);
      }
      return `(${word.passageLeaves.join(" OR ")})`;
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
  /** Each decision and the copy of it the page shows. */
  copies: readonly { id: string; revision: CorpusProjectionRevision }[];
};

/**
 * Which of the words each decision on a ranked page holds, in the copy the
 * page shows, and how that was read: off the decision field, or, for a
 * decision whose decision field holds only a prefix of its terms (written
 * that way when the whole did not fit the opening passage), off its passages
 * as well. A word such a decision lacks on its decision field may stand in
 * the part that was cut, so it is never reported missing on that field's say.
 */
export type RankedPageWords = {
  readonly decisionField: WordsRead;
  /** Decisions whose decision field is a cut prefix, read over their passages. */
  readonly cutDecisions: WordsRead;
};

/**
 * The page's words, bounded by the page: one aggregation per word on the
 * decision field, one for which decisions are cut, and, only when one is, one
 * per word over those decisions' passages.
 */
export const readRankedPageWords = async ({
  plan,
  copies,
  ...read
}: ReadRankedPageWordsOptions): Promise<
  Result<RankedPageWords, HandlerError<400 | 502 | 503>>
> => {
  const decisionField = await readWordsAtCopies({
    ...read,
    copies,
    wordQueries: plan.words.map((_, index) => plan.wordQuery(index, "")),
  });
  if (Result.isError(decisionField)) {
    return decisionField;
  }
  const marked = await readWordsAtCopies({
    ...read,
    copies,
    wordQueries: [plan.partialQuery],
  });
  if (Result.isError(marked)) {
    return marked;
  }
  const cut = copies.filter(
    ({ id }) => marked.value.get(id)?.held.has(0) === true,
  );
  if (cut.length === 0) {
    return Result.ok({
      decisionField: decisionField.value,
      cutDecisions: new Map(),
    });
  }
  const cutDecisions = await readWordsAtCopies({
    ...read,
    copies: cut,
    wordQueries: plan.words.map((_, index) => plan.passageWordQuery(index)),
  });
  return cutDecisions.map((passages) => ({
    decisionField: decisionField.value,
    cutDecisions: passages,
  }));
};

/**
 * A hit's words from the page's read. A cut decision holds a word when its
 * decision field or any of its passages does; any other decision, when its
 * decision field does.
 */
const pageWordsHeldAt = (
  words: RankedPageWords,
  id: string,
  shown: CorpusProjectionRevision | null,
): ReadonlySet<number> => {
  const onField = wordsHeldAt(words.decisionField, id, shown);
  if (!words.cutDecisions.has(id)) {
    return onField;
  }
  return new Set([...onField, ...wordsHeldAt(words.cutDecisions, id, shown)]);
};

const RANKED_PAGE_WORDS_TIMEOUT_SINK = failureSink({
  event: "case_law.search_ranked_words.timed_out",
  expected: [],
});

/**
 * The search's answer when a page's words could not be read. A page
 * states every hit's words, so it is not served without them: a read the
 * request's budget ended answers as the public-read timeout, which the agent
 * tools continue; any other failure answers as the index being unavailable,
 * as the search does when it cannot reach the index at all.
 */
export const pageWordsRefusal = (error: HandlerError) =>
  error.code === PUBLIC_READ_TIMEOUT_CODE ||
  publicReadTimeoutError(error) !== null
    ? publicReadTimeoutResponse({
        sink: RANKED_PAGE_WORDS_TIMEOUT_SINK,
        cause: error,
      })
    : searchIndexUnavailableResponse(error);

type RankedHitTermsOptions = {
  plan: RankedSearchPlan;
  words: RankedPageWords;
  /** Decisions an identifier named, which the words did not select. */
  pinnedIds: ReadonlySet<string>;
};

/** Each ranked hit's words: those its decision holds and those it lacks. */
export const rankedHitTerms =
  ({ plan, words, pinnedIds }: RankedHitTermsOptions) =>
  (id: string, shown: CorpusProjectionRevision | null): HitTerms => {
    if (pinnedIds.has(id)) {
      return NO_HIT_TERMS;
    }
    const held = pageWordsHeldAt(words, id, shown);
    return {
      matchedTerms: plan.words
        .filter((_, index) => held.has(index))
        .map(({ term }) => term),
      missingTerms: plan.words
        .filter((_, index) => !held.has(index))
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

/**
 * The counts' outcome in the shape the partial-pass steps settle in: none when
 * enough decisions hold every word, degraded when the step's budget ran out.
 */
export const rankedCountsOutcome = (
  step: BoundedRequestStep<Result<TermDecisionCounts | null, unknown>>,
): RelaxedTopUpOutcome<TermDecisionCounts> | null => {
  const outcome = relaxedTopUpOutcome(step);
  switch (outcome.type) {
    case "read":
      return outcome.value === null
        ? null
        : { type: "read", value: outcome.value };
    case "degraded":
    case "skipped":
      return outcome;
    default:
      outcome satisfies never;
      return panic("Unhandled ranked term counts outcome");
  }
};
