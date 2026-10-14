import { SEARCH_PAGE_END } from "@stll/api-contract/search";
import type { SearchPageEnd } from "@stll/api-contract/search";

import { markCorpusFragment } from "@/api/lib/legal-search/corpus-passage-highlight";
import type { CorpusQueryToken } from "@/api/lib/legal-search/corpus-query";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import type { RankedHit } from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";

/**
 * The relaxed phase of a corpus-index case-law search.
 *
 * Czech topic searches require every content word, so a question asked in
 * natural language often returns a handful of hits or none. When the strict
 * first page is short and its scan proved the strict set ended, the page is
 * topped up with decisions that hold only some of the words, ranked by how
 * many of them they hold. The strict hits stay first and untouched, and the
 * total and facets keep describing the strict set.
 */

/** Decisions the relaxed scan must leave out: everything the strict page showed. */
export type RelaxedExclusions = {
  ids: ReadonlySet<string>;
  /** A language sibling of a shown decision is the same judgment. */
  languageGroupKeys: ReadonlySet<string>;
};

type ShouldRelaxOptions = {
  body: { strict?: boolean | undefined };
  intentType: string;
  isFirstPage: boolean;
  /** Content terms the strict query required (a quoted phrase counts once). */
  requiredTermCount: number;
  sort: string;
  strictHitCount: number;
  limit: number;
  /** Why the strict scan ended; only a complete end proves the set is exhausted. */
  strictEnd: SearchPageEnd;
};

/**
 * Whether a strict page is topped up. Every condition is needed: a cursor or
 * offset page is a slice of a set the first page described, `newest` asks for
 * a date order a coverage ranking would break, `strict` asks for exactly the
 * words typed, an identifier is a lookup rather than a topic, one term has
 * nothing to relax, and a scan that stopped on a budget or has a
 * continuation has not shown the strict set ended.
 */
export const shouldRelaxCaseLawSearch = ({
  body,
  intentType,
  isFirstPage,
  requiredTermCount,
  sort,
  strictHitCount,
  limit,
  strictEnd,
}: ShouldRelaxOptions): boolean =>
  isFirstPage &&
  sort === "relevance" &&
  body.strict !== true &&
  intentType !== "identifier" &&
  requiredTermCount >= 2 &&
  strictEnd === SEARCH_PAGE_END.COMPLETE &&
  strictHitCount < limit;

/** Candidates scanned per slot, so coverage can promote a hit the engine ranked lower. */
const RELAXED_OVERFETCH = 3;

/**
 * How many relaxed hits the scan is asked for to fill `needed` slots: more
 * than needed, because the engine's order can rank a decision holding one
 * rare word above decisions holding several, and the cut by coverage can only
 * promote what the scan returned.
 */
export const relaxedFetchLimit = (needed: number): number =>
  Math.min(needed * RELAXED_OVERFETCH, LIMITS.caseLawSearchPageSizeMax);

const HTML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&amp;", "&"],
]);

const plainSnippet = (snippet: string): string =>
  snippet
    .replaceAll(/<\/?mark>/gu, "")
    .replaceAll(
      /&(?:lt|gt|quot|#39|amp);/gu,
      (entity) => HTML_ENTITIES.get(entity) ?? entity,
    );

type TermsCoveredOptions = {
  /** The excerpt shown for the hit, escaped, as the search returns it. */
  snippet: string | undefined;
  tokens: readonly CorpusQueryToken[];
  language: MorphologyLanguage | null;
};

/**
 * How many of the query's distinct terms the hit's excerpt carries, matched
 * the way the excerpt is highlighted (stemmed, so an inflected form counts).
 * The excerpt is the best passage of the decision, so this is a lower bound on
 * what the whole decision holds; it is cheap and needs no further read.
 */
export const termsCovered = ({
  snippet,
  tokens,
  language,
}: TermsCoveredOptions): number => {
  if (snippet === undefined) {
    return 0;
  }
  const text = plainSnippet(snippet);
  const seen = new Set<string>();
  let covered = 0;
  for (const token of tokens) {
    if (seen.has(token.value)) {
      continue;
    }
    seen.add(token.value);
    if (
      markCorpusFragment({ text, tokens: [token], language }).includes("<mark>")
    ) {
      covered += 1;
    }
  }
  return covered;
};

type RankByTermCoverageOptions = TermsCoveredOptionsWithoutSnippet & {
  ranked: readonly RankedHit[];
  snippetById: ReadonlyMap<string, string>;
};

type TermsCoveredOptionsWithoutSnippet = Omit<TermsCoveredOptions, "snippet">;

/**
 * Relaxed hits, the ones holding more of the query's terms first. The engine's
 * OR query sums per-term scores, which lets one rare word outrank decisions
 * holding several, so the coverage count leads and the existing blend (the
 * order of `ranked`) breaks ties; the sort is stable.
 */
export const rankByTermCoverage = ({
  ranked,
  snippetById,
  tokens,
  language,
}: RankByTermCoverageOptions): RankedHit[] =>
  ranked
    .map((hit, index) => ({
      hit,
      index,
      covered: termsCovered({
        snippet: snippetById.get(hit.id),
        tokens,
        language,
      }),
    }))
    .toSorted(
      (left, right) => right.covered - left.covered || left.index - right.index,
    )
    .map(({ hit }) => hit);
