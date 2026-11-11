import { normalizeCountry } from "@stll/agent-input";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  type PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  SEARCH_PAGINATION_COMPLETE,
  type SearchPaginationOutcome,
} from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { mapWithConcurrency } from "@stll/concurrency";

import type { PracticeJurisdiction } from "@/api/db/schema";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  defaultSearchDecisionsHandler,
  isSearchCaseLawSuccess,
  type SearchCaseLawSuccess,
} from "@/api/mcp/public-law-handlers";

/**
 * One case-law query asked of several corpus countries at once.
 *
 * The corpus search engine answers one country per request, so every surface
 * that searches "case law" without naming a country fans the query out here:
 * the OpenAI-compatible `search` (`compat-corpus.ts`) and the search palette's
 * case-law section. Each country is asked through the same handler
 * `search_case_law` and `POST /v1/case/decisions/search` use, so the corpus
 * index (or, on a deployment without it, that handler's bounded per-country
 * Postgres search) is the only engine; nothing here reads the corpus itself.
 */

/**
 * One country's position, keyed by country. A key absent means that country
 * has not been asked yet (its first page); a key holding `null` means its
 * pages ended on an earlier call and it is not asked again.
 *
 * Keyed by country rather than by position in a list, so neither the order
 * the countries are asked in nor a change to the practice jurisdictions
 * between pages moves any country's place. A cursor minted before a country
 * was asked resumes each country it names where it stopped and starts the
 * others at their first page: nothing already returned repeats and nothing is
 * skipped.
 */
export type CorpusSubCursors = Readonly<Record<string, string | null>>;

/** A practice jurisdiction in the corpus's alpha-3 spelling. */
export type PractisedCountry = { alpha3: string; isPrimary: boolean };

/**
 * The organization's practice jurisdictions in the corpus's spelling. The
 * column stores alpha-2 and the corpus keys on alpha-3; the shared country
 * reader is what converts between them everywhere else too. A code it cannot
 * read is left out rather than guessed at.
 */
export const practisedCorpusCountries = (
  jurisdictions: readonly Pick<
    PracticeJurisdiction,
    "countryCode" | "isPrimary"
  >[],
): PractisedCountry[] =>
  jurisdictions.flatMap(({ countryCode, isPrimary }) => {
    const normalized = normalizeCountry(countryCode, { spelling: "alpha-3" });
    return normalized.ok
      ? [{ alpha3: normalized.value.alpha3, isPrimary }]
      : [];
  });

const PRIMARY_RANK = 0;
const PRACTISED_RANK = 1;
const UNPRACTISED_RANK = 2;

/**
 * Every admitted country, ordered by the practice jurisdictions: the primary
 * one first, then the other practised ones, then the rest, each group in
 * admitted order. Ranking never removes a country; a caller that wants only
 * the practised ones selects them with {@link practisedCaseLawCountries}.
 */
export const rankCorpusCountries = <TCountry extends string>(
  admitted: readonly TCountry[],
  practised: readonly PractisedCountry[],
): readonly TCountry[] => {
  const rankByCountry = new Map<string, number>();
  for (const { alpha3, isPrimary } of practised) {
    const rank = isPrimary ? PRIMARY_RANK : PRACTISED_RANK;
    rankByCountry.set(
      alpha3,
      Math.min(rank, rankByCountry.get(alpha3) ?? UNPRACTISED_RANK),
    );
  }
  return admitted
    .map((country, index) => ({
      country,
      index,
      rank: rankByCountry.get(country) ?? UNPRACTISED_RANK,
    }))
    .toSorted(
      (left, right) => left.rank - right.rank || left.index - right.index,
    )
    .map(({ country }) => country);
};

/**
 * The admitted case-law countries an organization practises in, primary
 * first. When it has recorded none the corpus admits, every admitted country
 * in admitted order: an organization that has not said where it practises (or
 * practises only where the corpus holds nothing yet) still gets case law,
 * rather than an empty section with no way to change it from the search box.
 */
export const practisedCaseLawCountries = (
  practised: readonly PractisedCountry[],
  admitted: readonly PublicCaseLawCountry[] = PUBLIC_CASE_LAW_COUNTRIES,
): readonly PublicCaseLawCountry[] => {
  const practisedSet = new Set(practised.map(({ alpha3 }) => alpha3));
  const ranked = rankCorpusCountries(admitted, practised);
  const selected = ranked.filter((country) => practisedSet.has(country));
  return selected.length > 0 ? selected : ranked;
};

/**
 * A page cap split across the countries it is asked of, summing to exactly
 * the cap: a floor share each, plus one extra hit to the first
 * `cap % countries` of them in the order they are asked (practised first).
 *
 * The obvious equal floored share is wrong in both directions. Three countries
 * under a cap of five would each take one, spending three hits of the five;
 * twelve countries would each take the `Math.max(1, ...)` floor and return
 * twelve hits from a cap of five. Truncating the merged page afterwards cannot
 * repair that, because by then every country's cursor has advanced past hits
 * no continuation would ever emit again.
 */
export const corpusCountryQuotas = <TCountry>(
  cap: number,
  countries: readonly TCountry[],
): readonly { country: TCountry; limit: number }[] => {
  const share = Math.floor(cap / countries.length);
  const remainder = cap % countries.length;
  return countries.map((country, index) => ({
    country,
    limit: index < remainder ? share + 1 : share,
  }));
};

/**
 * Three states, as in `search_case_law`: a string continues this country, an
 * absent entry is its first page, and `null` means it ended on an earlier one.
 */
export const subCursorArgument = (
  cursors: CorpusSubCursors,
  country: string,
): { exhausted: true } | { exhausted: false; cursor?: string } => {
  const cursor = cursors[country];
  if (cursor === null) {
    return { exhausted: true };
  }
  return cursor === undefined
    ? { exhausted: false }
    : { exhausted: false, cursor };
};

/** A sub-cursor record read back from untrusted JSON, or null. */
export const readCorpusSubCursors = (
  value: unknown,
): CorpusSubCursors | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries: [string, unknown][] = Object.entries(value);
  const cursors: [string, string | null][] = [];
  for (const [country, cursor] of entries) {
    if (cursor !== null && typeof cursor !== "string") {
      return null;
    }
    cursors.push([country, cursor]);
  }
  return Object.fromEntries(cursors);
};

/**
 * A sub-cursor record as one opaque string, in the shared pagination
 * envelope (JSON-wrapped, base64url) every corpus cursor uses.
 */
export const encodeCaseLawCountriesCursor = (
  cursors: CorpusSubCursors,
): string => encodePaginationCursor([cursors]);

/** The record a cursor names, or null when it is not one this module issued. */
export const decodeCaseLawCountriesCursor = (
  cursor: string,
): CorpusSubCursors | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  return readCorpusSubCursors(parts[0]);
};

/**
 * The longest cursor {@link encodeCaseLawCountriesCursor} mints: every
 * admitted country holding a sub-cursor of the corpus search's own bound.
 * Running the actual wrapper over those bounds counts the country keys,
 * separators and base64url framing exactly.
 */
export const CASE_LAW_COUNTRIES_CURSOR_MAX_LENGTH =
  encodeCaseLawCountriesCursor(
    Object.fromEntries(
      PUBLIC_CASE_LAW_COUNTRIES.map((country) => [
        country,
        "a".repeat(CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH),
      ]),
    ),
  ).length;

/** Whether any country can still answer a further page. */
export const hasMoreCountryPages = (cursors: CorpusSubCursors): boolean =>
  Object.values(cursors).some((cursor) => cursor !== null);

export type CaseLawCountrySearch = typeof searchDecisionsHandler;

type CaseLawCountryAnswer = Awaited<ReturnType<CaseLawCountrySearch>>;

export type CaseLawSearchHit = SearchCaseLawSuccess["hits"][number];

export type CaseLawMultiCountryOutcome =
  | {
      type: "page";
      /** Each asked country's hits, in the order the countries were given. */
      countries: readonly {
        country: PublicCaseLawCountry;
        hits: readonly CaseLawSearchHit[];
      }[];
      cursors: Record<string, string | null>;
      paginationOutcome: SearchPaginationOutcome;
    }
  | {
      /**
       * The first country (in the order given) whose search did not answer
       * a page. A country that failed sinks the whole answer rather than
       * reading as "no law there": those are different answers to the same
       * question.
       */
      type: "failed";
      country: PublicCaseLawCountry;
      answer: Exclude<CaseLawCountryAnswer, SearchCaseLawSuccess>;
    };

export type SearchCaseLawCountriesOptions = {
  query: string;
  /** The countries to ask, in result order. */
  countries: readonly PublicCaseLawCountry[];
  cursors: CorpusSubCursors;
  /** The merged page's size, split across the countries. */
  cap: number;
  observer: RegistryRequestObservation;
  signal?: AbortSignal | undefined;
  search?: CaseLawCountrySearch;
};

/**
 * One page of a query across countries: each country's share of `cap`
 * (`corpusCountryQuotas`), asked concurrently from where its sub-cursor
 * stopped. A country whose pages ended is not asked and stays ended.
 *
 * The caller decides what a country is worth: hits come back per country, in
 * the order the countries were given, and are never re-scored across them.
 * Relevance numbers from two countries' searches are not comparable.
 */
export const searchCaseLawCountries = async ({
  query,
  countries,
  cursors,
  cap,
  observer,
  signal,
  search = defaultSearchDecisionsHandler,
}: SearchCaseLawCountriesOptions): Promise<CaseLawMultiCountryOutcome> => {
  if (countries.length === 0) {
    return {
      type: "page",
      countries: [],
      cursors: {},
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    };
  }

  const outcomes = await mapWithConcurrency({
    items: [...corpusCountryQuotas(cap, countries)],
    limit: countries.length,
    operation: async ({
      country,
      limit,
    }: {
      country: PublicCaseLawCountry;
      limit: number;
    }) => {
      const position = subCursorArgument(cursors, country);
      if (position.exhausted) {
        return { country, result: null } as const;
      }
      return {
        country,
        result: await search({
          body: {
            query,
            limit,
            country,
            // Callers read the page only: the facets and total the handler
            // would aggregate over each country's whole result set are
            // never read.
            describeResultSet: false,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
          },
          caseLawDb: caseLawPublicReadDb,
          observer,
          signal,
        }),
      } as const;
    },
  });

  const answered: {
    country: PublicCaseLawCountry;
    hits: CaseLawSearchHit[];
  }[] = [];
  const nextCursors: [PublicCaseLawCountry, string | null][] = [];
  let paginationOutcome: SearchPaginationOutcome = SEARCH_PAGINATION_COMPLETE;
  for (const { country, result } of outcomes) {
    if (result === null) {
      nextCursors.push([country, null]);
      continue;
    }
    if (!isSearchCaseLawSuccess(result)) {
      return { type: "failed", country, answer: result };
    }
    nextCursors.push([country, result.nextCursor]);
    if (result.paginationOutcome.type === "truncated") {
      paginationOutcome = result.paginationOutcome;
    }
    answered.push({ country, hits: result.hits });
  }
  return {
    type: "page",
    countries: answered,
    cursors: Object.fromEntries(nextCursors),
    paginationOutcome,
  };
};
