import { panic, Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import type { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";
import {
  caseLawHitGroup,
  type CaseLawHitOrder,
  type CaseLawSearchWarningCode,
  SEARCH_PAGE_END,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET,
  SEARCH_PAGINATION_TRUNCATED_TIME_BUDGET,
  searchPageEnd,
} from "@stll/api-contract/search";
import {
  euProvisionAnchor,
  locateEuProvisionCitations,
} from "@stll/legal-atlas/eu-provision-citations";
import { provisionCitationProfileFor } from "@stll/legal-atlas/provision-citation-profiles";
import {
  renderProvisionAnchor,
  resolveProvisionCitation,
} from "@stll/legal-atlas/provision-citation-resolve";
import { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { normalizePublicDecisionLanguage } from "@/api/lib/case-law/decision-language";
import {
  type CaseLawProvisionFilter,
  caseLawProvisionFilterOf,
  type CaseLawProvisionScope,
  readCaseLawProvisionScopeWithinBudget,
  readProvisionWorkLinked,
} from "@/api/lib/case-law/provision-filter";
import {
  type AgentCaseLawSearchWarning,
  manyRequiredTermsWarning,
  partialMatchesUnreadWarning,
  partialMatchesWarning,
  phrasingTimedOutWarning,
  provisionCitedWidelyWarning,
  provisionScopeUnreadWarning,
} from "@/api/lib/case-law/search-warnings";
import { projectCaseLawCourt } from "@/api/lib/chat/case-law-court-projection";
import { SEARCH_CASE_LAW_PROJECTION } from "@/api/lib/chat/projections";
import { runInCorpusSearchLane } from "@/api/lib/legal-search/corpus-index-admission";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { runBeforeRequestDeadline } from "@/api/lib/load/request-latency-budget";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { projectionPayload } from "@/api/lib/projection-totality";
import {
  getTenantActionSizePolicy,
  normalizeTenantPageLimit as normalizePage,
} from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import { resolveCourtFilter } from "@/api/mcp/case-law-court-filter";
import {
  MANY_REQUIRED_TERMS_THRESHOLD,
  searchCaseLawTexts,
} from "@/api/mcp/case-law-search-guidance";
import {
  SEARCH_CASE_LAW_TOOL,
  searchCaseLawArgsSchema,
} from "@/api/mcp/case-law-search-input";
import { statusCodeToErrorCode } from "@/api/mcp/error-codes";
import {
  defaultListCaseLawProvisionDecisions,
  isSearchCaseLawSuccess,
  type SearchCaseLawSuccess,
} from "@/api/mcp/public-law-handlers";
import { createToolContinuation } from "@/api/mcp/public-read-continuation";
import { serializeAuthorizedCorpusMcpResourceName } from "@/api/mcp/resource-serialization";
import type {
  InternalToolErrorResult,
  InternalToolResult,
} from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionAppUrl,
  caseLawSearchTimeoutResult,
  DEFAULT_SEARCH_LIMIT,
  handlerResultMessage,
  handlerStatusOf,
  internalFailureResult,
  invalidCursorResult,
  isCaseLawSearchTimeout,
  legalCitationLinkFields,
  notFoundResult,
  searchRefusalResult,
  structuredErrorResult,
  toolDataResult,
  toPlainTextSnippet,
} from "@/api/mcp/tool-utils";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";

import { boundCaseLawSearchHeadnotes } from "./case-law-search-headnotes";
import { searchNotesForCall } from "./search-notes";

/** What the engine answers for a cursor it cannot decode. */
const INVALID_CURSOR_MESSAGE = "Invalid cursor";

/** Read once at module load: tools/list is fixed for a running server. */
export const SEARCH_CASE_LAW_TEXTS = searchCaseLawTexts(
  envBase.MCP_CASE_LAW_SEARCH_GUIDANCE,
);
export const searchCaseLawArgs = searchCaseLawArgsSchema(SEARCH_CASE_LAW_TEXTS);

type CaseLawSearchHit = SearchCaseLawSuccess["hits"][number];

/**
 * One decision in the merged page: the hit as the best-ranking query returned
 * it, that rank, and which queries returned it at all.
 */
type MergedCaseLawHit = {
  hit: CaseLawSearchHit;
  /** `all_terms` when any query returned the decision as holding every word. */
  match: CaseLawSearchHit["match"];
  matchedQueries: number[];
  rank: number;
  /** The query whose hit represents the decision, which its words are of. */
  queryIndex: number;
};

/**
 * Merge one page per query into one page of distinct decisions.
 *
 * A hit carries no score on the wire, so its rank position within its own
 * query's page is the only comparable signal: a decision keeps the hit from
 * the query that ranked it highest, and ties go to the decision more
 * phrasings agree on, then to its id so the order is total.
 *
 * Within the page, and deliberately not across pages. Suppressing a repeat on
 * a later page means carrying every emitted id in the cursor: at the page
 * sizes this tool serves that is kilobytes of opaque string a model has to
 * copy back verbatim, and bounding it means a page count past which paging
 * simply stops. Repeating a decision costs a slot; refusing to page costs the
 * results. The input descriptions say which guarantee this is, and
 * `decisionId` is the key a caller dedupes on.
 */
export const mergeCaseLawSearchHits = (
  pagesByQuery: readonly (readonly CaseLawSearchHit[])[],
  // The order the search answered in: the merge keeps it, so a phrasing
  // reads in the same order here as from the search itself.
  order: CaseLawHitOrder,
): readonly MergedCaseLawHit[] => {
  const merged = new Map<string, MergedCaseLawHit>();
  for (const [queryIndex, hits] of pagesByQuery.entries()) {
    for (const [rank, hit] of hits.entries()) {
      const seen = merged.get(hit.decisionId);
      if (seen === undefined) {
        merged.set(hit.decisionId, {
          hit,
          match: hit.match,
          matchedQueries: [queryIndex],
          rank,
          queryIndex,
        });
      } else {
        // Queries are walked in index order, so this stays ascending.
        seen.matchedQueries.push(queryIndex);
        // A full match represents the decision over any partial one: its hit
        // (excerpt) and rank stand, and ranks compare only within one class,
        // so a promoted decision never sorts by its partial rank.
        const group = caseLawHitGroup(hit.match, order);
        const seenGroup = caseLawHitGroup(seen.match, order);
        if (group < seenGroup || (group === seenGroup && rank < seen.rank)) {
          seen.hit = hit;
          seen.rank = rank;
          seen.match = hit.match;
          seen.queryIndex = queryIndex;
        }
      }
    }
  }
  // The id tiebreak is a code-unit comparison, not a collation: a decision id
  // is an opaque key, and all the order has to be is total and stable.
  return [...merged.values()].toSorted(
    (left, right) =>
      // Under `all_words_first` partial matches follow every full match:
      // within one query they are appended after it, and ranks of different
      // queries are not comparable across that line. Under `score` both
      // matches share one group and rank decides.
      caseLawHitGroup(left.match, order) -
        caseLawHitGroup(right.match, order) ||
      left.rank - right.rank ||
      right.matchedQueries.length - left.matchedQueries.length ||
      (left.hit.decisionId < right.hit.decisionId ? -1 : 1),
  );
};

/** A page whose partial-match phase was due and did not finish. */
export const partialMatchesUnread = (outcome: {
  type: string;
  reason?: string;
}): boolean =>
  outcome.type === SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET.type &&
  outcome.reason === SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET.reason;

/**
 * The order the merged page keeps: the one every phrasing's page names. All
 * phrasings of a call read one generation, so they name the same order; a
 * call whose pages disagree keeps full matches first, which no page's own
 * order contradicts within itself.
 */
export const mergedCaseLawHitOrder = (
  pages: readonly CaseLawQueryOutcome[],
): CaseLawHitOrder => {
  const orders = new Set(
    pages.flatMap((outcome) =>
      outcome.type === "page" ? [outcome.page.hitOrder] : [],
    ),
  );
  const [only] = orders;
  return orders.size === 1 && only !== undefined ? only : "all_words_first";
};

/**
 * A phrasing in the merged cursor that has returned no page yet. `null` means
 * the phrasing ended and a string is its continuation; a timed-out first page
 * is neither, and this marks it so the next call runs that page.
 */
const CASE_LAW_PHRASING_FIRST_PAGE_PENDING = "";

/**
 * The per-query cursors a call resumes from. `null` is a query whose page
 * ended, which is not re-run; `undefined` is a query on its first page.
 */
type CaseLawSearchCursors =
  | { type: "cursors"; cursors: readonly (string | null | undefined)[] }
  | { type: "invalid" }
  | { type: "count_mismatch"; encoded: number };

/**
 * A single query pages on the engine's own cursor, passed through verbatim;
 * several queries page on one envelope carrying a sub-cursor each. The two
 * grammars are disjoint (an engine cursor never decodes to a JSON array), so
 * one decode tells them apart and a cursor issued for a different number of
 * queries is rejected rather than silently continuing the wrong one.
 */
export const resolveCaseLawSearchCursors = ({
  cursor,
  queryCount,
}: {
  cursor: string | undefined;
  queryCount: number;
}): CaseLawSearchCursors => {
  // An empty string is a model spelling an absent optional, not a page
  // boundary: decoding it would answer "invalid cursor" for a first page.
  if (cursor === undefined || cursor.length === 0) {
    return {
      type: "cursors",
      cursors: Array.from({ length: queryCount }, () => undefined),
    };
  }
  const parts = decodePaginationCursor(cursor);
  if (parts === null) {
    // One query pages on the engine's own cursor, which the engine decodes.
    // Several page on this envelope, and a string that is not one was never
    // issued for them: it is an unreadable cursor, not a cursor for a
    // different number of queries.
    return queryCount === 1
      ? { type: "cursors", cursors: [cursor] }
      : { type: "invalid" };
  }
  if (
    !parts.every(
      (part): part is string | null =>
        part === null || typeof part === "string",
    )
  ) {
    return { type: "invalid" };
  }
  return parts.length === queryCount
    ? {
        type: "cursors",
        cursors: parts.map((part) =>
          part === CASE_LAW_PHRASING_FIRST_PAGE_PENDING ? undefined : part,
        ),
      }
    : { type: "count_mismatch", encoded: parts.length };
};

/**
 * The values each filter the request set could have taken, from a page's own
 * facets: each facet counts its dimension under the other filters, so these
 * are the values that would have matched. Named on an empty page so the next
 * call picks one rather than guessing another.
 */
export const facetValuesForFilters = ({
  facets,
  filters,
}: {
  facets: SearchCaseLawSuccess["facets"];
  filters: {
    /** The court spellings the search narrowed by, from either court filter. */
    court: readonly string[] | undefined;
    decisionType: string | undefined;
    language: string | undefined;
  };
}): { filter: string; values: string[] }[] => {
  if (facets === null) {
    return [];
  }
  return [
    ...(filters.court === undefined
      ? []
      : [
          {
            filter: "court",
            values: facets.court.flatMap((tier) =>
              tier.courts.map((bucket) => bucket.value),
            ),
          },
        ]),
    ...(filters.decisionType === undefined
      ? []
      : [
          {
            filter: "decision_type",
            values: facets.decisionType.map((bucket) => bucket.value),
          },
        ]),
    ...(filters.language === undefined
      ? []
      : [
          {
            filter: "language",
            values: facets.language.map((bucket) => bucket.value),
          },
        ]),
  ];
};

/**
 * One query's page, the mark of a query whose page had already ended, or a
 * query the call's time budget stopped before it answered. A timed-out query
 * keeps the cursor it ran from, so the merged page's continuation runs it
 * again.
 */
type CaseLawQueryOutcome =
  | { type: "exhausted" }
  | { type: "page"; page: SearchCaseLawSuccess }
  | { type: "timed_out"; subCursor: string | undefined };

type CaseLawSearchAnswer =
  | { type: "page"; page: SearchCaseLawSuccess }
  | { type: "failed"; result: InternalToolErrorResult }
  /** The search ran out of its time budget; `result` is the retryable error. */
  | { type: "timed_out"; result: InternalToolErrorResult };

/** One query's handler answer read as its page or the tool's refusal. */
/**
 * A search the handler refused or failed, in the typed envelope every other
 * failure of this tool uses. A caller's mistake keeps its message and gains a
 * code; anything else is captured and answered generically.
 */
const caseLawSearchFailedResult = (
  answer: unknown,
): InternalToolErrorResult => {
  const status = handlerStatusOf(answer);
  const code = statusCodeToErrorCode(status?.code ?? 500);
  return status?.message && code !== "internal_error"
    ? structuredErrorResult({ code, message: status.message })
    : internalFailureResult(answer, "mcp.searchRefusal");
};

const readCaseLawSearchAnswer = (
  answer: Parameters<typeof isSearchCaseLawSuccess>[0],
  cursor: string | undefined,
): CaseLawSearchAnswer => {
  const timeout = caseLawSearchTimeoutResult(answer);
  if (timeout !== null) {
    return { type: "timed_out", result: timeout };
  }
  const refusal = searchRefusalResult(answer);
  if (refusal !== null) {
    return { type: "failed", result: refusal };
  }
  const resultMessage = handlerResultMessage(answer);
  if (resultMessage === INVALID_CURSOR_MESSAGE) {
    return {
      type: "failed",
      result: invalidCursorResult({
        cursor: cursor ?? "",
        tool: SEARCH_CASE_LAW_TOOL,
      }),
    };
  }
  if (resultMessage || !isSearchCaseLawSuccess(answer)) {
    return { type: "failed", result: caseLawSearchFailedResult(answer) };
  }
  return { type: "page", page: answer };
};

type SearchProvisionRead =
  | { type: "resolved"; provision: CaseLawProvisionFilter }
  | { type: "refused"; result: InternalToolErrorResult };

const provisionRefusal = (
  message: string,
  hint: string,
): SearchProvisionRead => ({
  type: "refused",
  result: structuredErrorResult({
    code: "validation_error",
    message,
    hint,
    issues: [{ path: "provision", message }],
  }),
});

/**
 * No EU provision links are recorded yet, so a corrected EU filter would only
 * answer not_found: the next call a refusal names is the text search.
 */
const EU_PROVISION_FILTER_HINT =
  "Omit provision and name the EU provisions in queries.";

/**
 * Reads the provision a caller names against the country's citation profile,
 * the vocabulary the corpus's provision links were extracted with, as the act
 * in force today. Every refusal names what to send instead.
 */
const resolveSearchProvision = (
  text: string,
  country: string,
): SearchProvisionRead => {
  const citedOn = Temporal.Now.plainDateISO("UTC").toString();
  const euCitations = locateEuProvisionCitations(text, { citedOn });
  if (euCitations.length > 1) {
    return provisionRefusal(
      "The provision names several provisions or a range",
      EU_PROVISION_FILTER_HINT,
    );
  }
  const euCitation = euCitations.at(0);
  if (euCitation !== undefined) {
    const before = text.slice(0, euCitation.start).trim();
    const after = text.slice(euCitation.end).trim();
    if (before.length > 0 || (after.length > 0 && after !== ".")) {
      return provisionRefusal(
        "The provision names several provisions or contains unsupported text",
        EU_PROVISION_FILTER_HINT,
      );
    }
    const { reference } = euCitation;
    return {
      type: "resolved",
      provision: caseLawProvisionFilterOf({
        jurisdiction: "EU",
        work: euCitation.act.celex,
        path: reference,
        anchorOf: (named) =>
          euProvisionAnchor({ ...named, openEnded: false, sentence: null }),
      }),
    };
  }
  const profile = provisionCitationProfileFor(country);
  if (profile === null) {
    return provisionRefusal(
      `Provision filtering is not available for ${country}`,
      "Omit provision and put the provision in queries instead.",
    );
  }
  const read = resolveProvisionCitation({
    text,
    profile,
    citedOn,
  });
  switch (read.status) {
    case "resolved":
      return {
        type: "resolved",
        provision: caseLawProvisionFilterOf({
          work: read.workIdentifier,
          path: read,
          anchorOf: (path) => renderProvisionAnchor(profile, path),
        }),
      };
    case "no_provision":
      return provisionRefusal(
        "The provision names no section",
        'Write it with its section, for example "§ 316 odst. 2 ZP" or "čl. 10 Listiny".',
      );
    case "multiple_provisions":
      return provisionRefusal(
        "The provision names several provisions or a range",
        'Pass one provision per search, for example "§ 316 odst. 2 ZP"; search the others separately, or name them in queries.',
      );
    case "no_act":
      return provisionRefusal(
        "The provision names no act this corpus recognises",
        'Name the act by abbreviation, title or number, for example "§ 316 ZP", "§ 316 zákoníku práce" or "§ 316 zákona č. 262/2006 Sb.".',
      );
    case "ambiguous_act":
      return provisionRefusal(
        "The provision's act name fits more than one act",
        `Name the act by number: ${read.candidates
          .map(({ workIdentifier }) => workIdentifier)
          .join(", ")}.`,
      );
    case "unit_mismatch":
      return provisionRefusal(
        `${read.workIdentifier} is not divided into the units the provision names`,
        "Use the act's own unit: articles (čl.) or sections (§).",
      );
    default:
      read satisfies never;
      return panic(`Unknown provision resolution ${String(read)}`);
  }
};

export const caseLawSearchRequestFilters = ({
  category,
  docket_registers: docketRegisters,
  senate,
  has_legal_sentence: hasLegalSentence,
  language,
  decision_type: decisionType,
  source_id: sourceId,
  date_from: dateFrom,
  date_to: dateTo,
  sort,
  strict,
}: v.InferOutput<typeof searchCaseLawArgs>) => ({
  ...(category === undefined ? {} : { category }),
  ...(hasLegalSentence === undefined ? {} : { hasLegalSentence }),
  ...(docketRegisters === undefined ? {} : { docketRegisters }),
  ...(senate === undefined ? {} : { senate }),
  ...(language === undefined ? {} : { language }),
  ...(decisionType === undefined ? {} : { decisionType }),
  ...(sourceId === undefined
    ? {}
    : { sourceId: brandPersistedCaseLawSourceId(sourceId) }),
  ...(dateFrom === undefined ? {} : { dateFrom }),
  ...(dateTo === undefined ? {} : { dateTo }),
  ...(sort === undefined ? {} : { sort }),
  ...(strict === undefined ? {} : { strict }),
});

export const validateSearchQueryPage = (limit: number, queryCount: number) => {
  if (getTenantActionSizePolicy() !== undefined && limit < queryCount) {
    return structuredErrorResult({
      code: "validation_error",
      message: "The configured page limit cannot include every search query",
      issues: [
        {
          path: "queries",
          message: "Each query needs at least one result slot.",
        },
      ],
      hint: `Send at most ${String(limit)} queries per search_case_law call, keeping the same queries when continuing a cursor.`,
    });
  }
  return undefined;
};

export const mismatchedSearchCursorResult = (
  encoded: number,
  queryCount: number,
) =>
  structuredErrorResult({
    code: "validation_error",
    message: "Cursor was issued for a different set of queries",
    issues: [
      {
        path: "cursor",
        message: `This cursor continues ${String(encoded)} queries; the call carries ${String(queryCount)}.`,
      },
    ],
    hint: `Send the same ${String(encoded)} queries this cursor was issued for, in the same order, or omit 'cursor' to start a new search.`,
  });

export const mcpCorpusQueryVariant = ({
  testDependencies,
}: AuthorizedMcpRequestContext) =>
  testDependencies?.corpusIndexQueryVariant ??
  envBase.CORPUS_INDEX_QUERY_VARIANT;

type ManyRequiredTermsOptions = {
  /** The phrasing's cursor this call: `undefined` is its first page. */
  subCursor: string | null | undefined;
  /**
   * The page the phrasing returned. What follows it is read from everything
   * the search answered (`searchPageEnd`): only `complete` proves the
   * phrasing was exhausted. Its `queryUsed` is a fixed point of the
   * tokenizer.
   */
  page: Pick<
    SearchCaseLawSuccess,
    "hits" | "nextCursor" | "pageReach" | "paginationOutcome" | "queryUsed"
  >;
  /** The result slots the phrasing was given. */
  slots: number;
};

/**
 * `many_required_terms` for a long phrasing exhausted on its first page,
 * read from the page already returned. A continuation is not asked about: it
 * is short at the end of every result set. A short first page that still
 * carries a cursor (a ranked row gone before hydration) has unread results,
 * and one whose scan stopped on a budget may have them too, so neither is
 * exhausted. A quoted phrase requires each of its words.
 */
const manyRequiredTermsWarnings = ({
  subCursor,
  page,
  slots,
}: ManyRequiredTermsOptions): AgentCaseLawSearchWarning[] => {
  const end = searchPageEnd({
    nextCursor: page.nextCursor,
    paginationOutcome: page.paginationOutcome,
    reach: page.pageReach,
  });
  // Partial matches can fill the slots without one decision holding every
  // word, so only the hits that hold them all count against the slots.
  if (
    subCursor !== undefined ||
    end !== SEARCH_PAGE_END.COMPLETE ||
    page.hits.filter(({ match }) => match === "all_terms").length >= slots
  ) {
    return [];
  }
  const tokens = tokenizeCorpusFreeText(page.queryUsed);
  const wordCount = tokens.reduce(
    (count, { value }) => count + value.split(" ").length,
    0,
  );
  return wordCount < MANY_REQUIRED_TERMS_THRESHOLD
    ? []
    : [
        manyRequiredTermsWarning({
          terms: tokens.map((token) =>
            token.type === "phrase" ? `"${token.value}"` : token.value,
          ),
          wordCount,
          slots,
        }),
      ];
};

/** The codes a phrasing's partial matches are told under, in either order. */
export const PARTIAL_MATCH_WARNING_CODES: ReadonlySet<string> = new Set([
  "partial_matches_appended",
  "partial_matches_ranked",
] satisfies readonly CaseLawSearchWarningCode[]);

type PartialMatchWarningOptions = {
  merged: readonly MergedCaseLawHit[];
  /** The order the merged page is in, which decides the warning's wording. */
  order: CaseLawHitOrder;
  queryIndex: number;
  countsStrictSet: boolean;
};

/**
 * The partial-match warning for a phrasing, counted on the merged response
 * the caller reads: a hit another phrasing matched in full is returned as
 * `all_terms`, so it is not counted here. Worded from the merged page's own
 * order, so it never says partial hits follow the full ones on a page that
 * ranks them together.
 */
const partialMatchWarnings = ({
  merged,
  order,
  queryIndex,
  countsStrictSet,
}: PartialMatchWarningOptions): AgentCaseLawSearchWarning[] => {
  const partial = merged.filter(
    (result) =>
      result.match === "some_terms" &&
      result.matchedQueries.includes(queryIndex),
  ).length;
  return partial === 0
    ? []
    : [partialMatchesWarning({ partial, countsStrictSet, order })];
};

const preferredLanguageOf = ({
  language,
  preferred_language: preferredLanguage,
}: v.InferOutput<typeof searchCaseLawArgs>): string | null =>
  language === undefined
    ? normalizePublicDecisionLanguage(preferredLanguage)
    : null;

/**
 * The hit a caller asked to read in another language, as that version. The
 * decision is the same; the snippet stays the one that matched.
 */
const preferredLanguageHit = <
  THit extends ReturnType<typeof mergeCaseLawSearchHits>[number]["hit"],
>(
  hit: THit,
  preferredLanguage: string | null,
) => {
  const version =
    preferredLanguage === null ||
    normalizePublicDecisionLanguage(hit.language) === preferredLanguage
      ? undefined
      : hit.languageAlternates.find(
          ({ language }) =>
            normalizePublicDecisionLanguage(language) === preferredLanguage,
        );
  return version === undefined
    ? hit
    : {
        ...hit,
        decisionId: version.id,
        caseNumber: version.caseNumber,
        court: version.court,
        decisionDate: version.decisionDate,
        language: version.language,
        slug: version.slug,
        // The alternates read carries no publisher link; the reader URL and
        // read_case_law_decision give this version's own.
        sourceUrl: null,
      };
};

const caseLawSearchResult = ({
  hit: matchedHit,
  match,
  matchedQueries,
  queryIndex,
  preferredLanguage,
}: ReturnType<typeof mergeCaseLawSearchHits>[number] & {
  preferredLanguage: string | null;
}) => {
  const hit = preferredLanguageHit(matchedHit, preferredLanguage);
  const resource = resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: brandPersistedCaseLawDecisionId(hit.decisionId),
  });
  return {
    matchedQueries,
    ...legalCitationLinkFields({
      url: buildCaseLawDecisionAppUrl({
        caseNumber: hit.caseNumber,
        country: hit.country,
        court: hit.court,
        decisionId: hit.decisionId,
        language: hit.language,
        languageAlternates: hit.languageAlternates,
        slug: hit.slug,
      }),
      sourceUrl: hit.sourceUrl,
    }),
    caseNumber: hit.caseNumber,
    citationAuthority: hit.citationAuthority,
    citationCount: hit.citationCount,
    country: hit.country,
    ...projectCaseLawCourt(hit),
    decisionDate: hit.decisionDate,
    decisionId: hit.decisionId,
    resourceName: serializeAuthorizedCorpusMcpResourceName(resource),
    decisionType: hit.decisionType,
    decisionTypeKind: hit.decisionTypeKind,
    ecli: hit.ecli,
    language: hit.language,
    matchingPassages: hit.matchingPassages,
    textAvailability: hit.textAvailability,
    match,
    terms: {
      query: queryIndex,
      matched: matchedHit.matchedTerms,
      missing: matchedHit.missingTerms,
    },
    ...(hit.textWithheldReason === null
      ? {
          snippet: toPlainTextSnippet(hit.headline),
          keywords:
            hit.keywords === null
              ? null
              : { ...hit.keywords, items: [...hit.keywords.items] },
          headnote:
            hit.headnote.type === TEXT_FIELD_TYPE.PRESENT ? hit.headnote : null,
        }
      : {
          excerpt: {
            type: "withheld" as const,
            reason: hit.textWithheldReason,
          },
          // Headnote and classifications are the source's own text: the
          // licence that withholds the excerpt withholds them too.
          keywords: null,
          headnote: null,
        }),
  };
};

/** The page's results, one per decision a preferred language serves alike. */
export const caseLawSearchResults = (
  merged: ReturnType<typeof mergeCaseLawSearchHits>,
  args: v.InferOutput<typeof searchCaseLawArgs>,
) => {
  const preferredLanguage = preferredLanguageOf(args);
  const served = new Map<string, ReturnType<typeof caseLawSearchResult>>();
  for (const entry of merged) {
    const result = caseLawSearchResult({ ...entry, preferredLanguage });
    const earlier = served.get(result.decisionId);
    served.set(
      result.decisionId,
      earlier === undefined
        ? result
        : {
            ...earlier,
            matchedQueries: [
              ...new Set([...earlier.matchedQueries, ...result.matchedQueries]),
            ].toSorted((left, right) => left - right),
          },
    );
  }
  return [...served.values()];
};

/**
 * The merged page's continuation: null when every query is exhausted, which
 * makes the merged page the last one; otherwise each query's own cursor.
 */
export const mergedCaseLawSearchCursor = (
  pages: readonly CaseLawQueryOutcome[],
): string | null => {
  const subCursors = pages.map((outcome) => {
    switch (outcome.type) {
      case "exhausted":
        return null;
      case "page":
        // A first page whose partial matches went unread runs again: the
        // phase only runs on a first page, and its strict scan had ended.
        return partialMatchesUnread(outcome.page.paginationOutcome)
          ? CASE_LAW_PHRASING_FIRST_PAGE_PENDING
          : outcome.page.nextCursor;
      case "timed_out":
        // A continuation runs the page again; a first page runs for the
        // first time, so it is carried as pending rather than as ended.
        return outcome.subCursor ?? CASE_LAW_PHRASING_FIRST_PAGE_PENDING;
      default:
        outcome satisfies never;
        return panic("Unhandled case-law query outcome");
    }
  });
  return subCursors.every((subCursor) => subCursor === null)
    ? null
    : encodePaginationCursor(subCursors);
};

/**
 * The merged page's outcome: truncated on the time budget when a phrasing
 * timed out (the page's cursor runs it again), else on the exclusion budget
 * when a phrasing's own page stopped there, else complete.
 */
export const mergedCaseLawPaginationOutcome = (
  pages: readonly CaseLawQueryOutcome[],
) => {
  if (pages.some(({ type }) => type === "timed_out")) {
    return SEARCH_PAGINATION_TRUNCATED_TIME_BUDGET;
  }
  if (
    pages.some(
      (outcome) =>
        outcome.type === "page" &&
        partialMatchesUnread(outcome.page.paginationOutcome),
    )
  ) {
    return SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET;
  }
  return pages.some(
    (outcome) =>
      outcome.type === "page" &&
      outcome.page.paginationOutcome.type === "truncated",
  )
    ? SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET
    : SEARCH_PAGINATION_COMPLETE;
};

export type SearchProvisionArgRead =
  | { type: "refused"; result: InternalToolErrorResult }
  | {
      type: "read";
      /** What every phrasing's search body carries for the provision. */
      body: {
        provision?: CaseLawProvisionFilter;
        provisionScope?: CaseLawProvisionScope;
      };
      warnings: AgentCaseLawSearchWarning[];
    };

/**
 * The provision argument, resolved and, for a search with queries, its
 * citing set read once for every phrasing. A set too wide for one search to
 * filter by is said in a warning on each phrasing, without enumerating every citation.
 */
export const readSearchProvision = async ({
  args,
  context,
  country,
}: {
  args: v.InferOutput<typeof searchCaseLawArgs>;
  context: AuthorizedMcpRequestContext;
  country: string;
}): Promise<SearchProvisionArgRead> => {
  const text = args.provision;
  if (text === undefined) {
    return { type: "read", body: {}, warnings: [] };
  }
  const resolved = resolveSearchProvision(text, country);
  if (resolved.type === "refused") {
    return resolved;
  }
  const { provision } = resolved;
  // An act no recorded link names would read as an exact 0 ("nothing cites
  // it") when its citations were never extracted; the caller is told so and
  // sent to the text search, which reads the decisions themselves.
  const readWorkLinked =
    context.testDependencies?.readProvisionWorkLinked ??
    (async (scope) =>
      await caseLawPublicReadDb(
        async (tx) => await readProvisionWorkLinked(tx, scope),
      ));
  if (!(await readWorkLinked({ jurisdiction: country, provision }))) {
    return {
      type: "refused",
      result: notFoundResult(
        `The case-law corpus records no provision links to ${provision.work} yet, so it cannot list the decisions citing ${text}`,
        `Search for the provision as text instead: omit provision and pass queries, for example ${JSON.stringify([text])}.`,
      ),
    };
  }
  // A provision-only list is complete by construction: no set to read.
  if (args.queries === undefined) {
    return { type: "read", body: { provision }, warnings: [] };
  }
  const readScope =
    context.testDependencies?.readCaseLawProvisionScope ??
    (async (scope) =>
      await readCaseLawProvisionScopeWithinBudget(caseLawPublicReadDb, scope));
  const provisionScope = await readScope({ jurisdiction: country, provision });
  return {
    type: "read",
    body: { provision, provisionScope },
    warnings: provisionScopeWarnings(provisionScope, text),
  };
};

const provisionScopeWarnings = (
  scope: CaseLawProvisionScope,
  provision: string,
): AgentCaseLawSearchWarning[] => {
  switch (scope.type) {
    case "decisions":
      return [];
    case "broad":
      return [provisionCitedWidelyWarning({ provision })];
    case "unread":
      return [provisionScopeUnreadWarning({ provision })];
    default:
      scope satisfies never;
      return panic("Unhandled provision scope");
  }
};

type ListSearchCaseLawProvisionOptions = {
  args: v.InferOutput<typeof searchCaseLawArgs>;
  context: AuthorizedMcpRequestContext;
  country: NonNullable<ReturnType<typeof publicCaseLawCountry>>;
  /** Absent when the call named neither queries nor a provision. */
  provision: CaseLawProvisionFilter | undefined;
};

/**
 * A provision with no queries: the complete list of decisions citing it, one
 * page at a time, in the same result shape a search returns. The cursor is
 * the list's own, passed through unchanged.
 */
export const listSearchCaseLawProvision = async ({
  args,
  context,
  country,
  provision,
}: ListSearchCaseLawProvisionOptions): Promise<
  InternalToolResult<FinishedSearchCaseLawData>
> => {
  if (provision === undefined) {
    const message = "Pass queries, a provision, or both";
    return structuredErrorResult({
      code: "validation_error",
      message,
      hint: 'Add queries with the question, or provision with the cited statute provision, for example "§ 316 odst. 2 ZP".',
      issues: [{ path: "queries", message }],
    });
  }
  const {
    court: courtFilter,
    courts: courtListFilter,
    warnings: filterWarnings,
  } = await resolveCourtFilter({
    context,
    country,
    court: args.court,
    courts: args.courts,
  });
  const list =
    context.testDependencies?.listCaseLawProvisionDecisions ??
    defaultListCaseLawProvisionDecisions;
  const provisionText =
    args.provision ?? panic("A provision list has no provision");
  const answer = readCaseLawSearchAnswer(
    await list({
      body: {
        // The list ranks no text; the provision as written is what it reads.
        query: provisionText,
        facets: args.facets,
        sentenceAlignedExcerpt: true,
        headnotePresentation: "expanded",
        limit: normalizePage(args.limit ?? DEFAULT_SEARCH_LIMIT),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(courtFilter === undefined ? {} : { court: courtFilter }),
        ...(courtListFilter === undefined ? {} : { courts: courtListFilter }),
        ...caseLawSearchRequestFilters(args),
        provision,
        country,
      },
      caseLawDb: caseLawPublicReadDb,
    }),
    args.cursor,
  );
  if (answer.type !== "page") {
    return answer.result;
  }
  const { page } = answer;
  const merged = mergeCaseLawSearchHits([page.hits], page.hitOrder);
  const payload = boundCaseLawSearchHeadnotes({
    headnotes: "included",
    facets: page.facets,
    searches: searchNotesForCall(
      [
        {
          query: provisionText,
          queryUsed: page.queryUsed,
          paginationOutcome: page.paginationOutcome,
          warnings: [...filterWarnings, ...page.warnings],
        },
      ],
      [],
    ),
    nextCursor: page.nextCursor,
    paginationOutcome: page.paginationOutcome,
    results: caseLawSearchResults(merged, args),
    total: page.total,
  });
  return toolDataResult(projectionPayload(SEARCH_CASE_LAW_PROJECTION, payload));
};

type CaseLawSearchCallOutcome =
  | { type: "exhausted" }
  | {
      type: "answered";
      subCursor: string | undefined;
      result: Parameters<typeof readCaseLawSearchAnswer>[0];
    }
  | {
      /**
       * The search rejected. `run` is the search's own promise, so the
       * original failure can still reach the tool boundary unchanged.
       */
      type: "rejected";
      subCursor: string | undefined;
      run: Promise<Parameters<typeof readCaseLawSearchAnswer>[0]>;
      error: unknown;
    };

/**
 * The rejected search the call hands to the tool boundary, if any.
 *
 * A rejection that is the time budget running out is that phrasing's alone,
 * and stays with the phrasings. Any other rejected search goes to the boundary
 * unchanged, which reads it as it always has (an admission outcome, its
 * failure grade).
 */
const caseLawSearchRejectionForBoundary = (
  outcomes: readonly CaseLawSearchCallOutcome[],
): Extract<CaseLawSearchCallOutcome, { type: "rejected" }> | null =>
  outcomes
    .filter(
      (
        outcome,
      ): outcome is Extract<CaseLawSearchCallOutcome, { type: "rejected" }> =>
        outcome.type === "rejected",
    )
    .find(({ error }) => !isCaseLawSearchTimeout(error)) ?? null;

/**
 * Each phrasing's outcome, the call's failure, or the rejected search the call
 * hands to the tool boundary.
 *
 * A phrasing that failed for any reason but its time budget sinks the call.
 * A phrasing that ran out of time while another answered does not: the page
 * carries the phrasings that finished, and the timed-out one is reported as
 * such (`phrasing_timed_out`, truncated outcome) rather than left out, since a
 * merged page silently missing one phrasing reads as "that phrasing found
 * nothing", which is a different answer. `none_finished` is every phrasing
 * run this call having run out of time, however each one expired.
 */
const readCaseLawQueryPages = (
  outcomes: readonly CaseLawSearchCallOutcome[],
  cursor: string | undefined,
):
  | { type: "failed"; result: InternalToolErrorResult }
  | { type: "none_finished"; result: InternalToolErrorResult }
  | {
      type: "rejected";
      run: Promise<Parameters<typeof readCaseLawSearchAnswer>[0]>;
    }
  | { type: "pages"; pages: CaseLawQueryOutcome[] } => {
  const boundary = caseLawSearchRejectionForBoundary(outcomes);
  if (boundary !== null) {
    return { type: "rejected", run: boundary.run };
  }
  const pages: CaseLawQueryOutcome[] = [];
  let timeout: InternalToolErrorResult | null = null;
  const rejectedTimeouts: unknown[] = [];
  for (const outcome of outcomes) {
    switch (outcome.type) {
      case "exhausted":
        pages.push({ type: "exhausted" });
        break;
      case "rejected":
        // Only a time-budget rejection reaches here.
        rejectedTimeouts.push(outcome.error);
        pages.push({ type: "timed_out", subCursor: outcome.subCursor });
        break;
      case "answered": {
        const answer = readCaseLawSearchAnswer(outcome.result, cursor);
        switch (answer.type) {
          case "failed":
            return answer;
          case "timed_out":
            timeout ??= answer.result;
            pages.push({ type: "timed_out", subCursor: outcome.subCursor });
            break;
          case "page":
            pages.push({ type: "page", page: answer.page });
            break;
          default:
            answer satisfies never;
            return panic("Unhandled case-law search answer");
        }
        break;
      }
      default:
        outcome satisfies never;
        return panic("Unhandled case-law search call outcome");
    }
  }
  if (pages.some(({ type }) => type === "page")) {
    // No error answers these, so reading each is what records it, as an
    // answered timeout is recorded.
    for (const error of rejectedTimeouts) {
      caseLawSearchTimeoutResult(error);
    }
    return { type: "pages", pages };
  }
  // A thrown expiry keeps the answer the tool boundary gives it, so a search
  // reads the same whichever phrasing count it ran with.
  const rejected = rejectedTimeouts.at(0);
  const expired =
    rejected === undefined
      ? timeout
      : (searchRefusalResult(rejected) ??
        caseLawSearchTimeoutResult(rejected) ??
        panic("A rejection kept with the phrasings is not a timeout"));
  return expired === null
    ? { type: "pages", pages }
    : { type: "none_finished", result: expired };
};
/**
 * Each phrasing's page or the call's failure. A rejected search the call
 * hands to the tool boundary is read again: that rejects with its original
 * failure, exactly as an unmerged search would.
 */
export const settleCaseLawQueryPages = async (
  outcomes: readonly CaseLawSearchCallOutcome[],
  cursor: string | undefined,
): Promise<
  Exclude<ReturnType<typeof readCaseLawQueryPages>, { type: "rejected" }>
> => {
  const read = readCaseLawQueryPages(outcomes, cursor);
  if (read.type !== "rejected") {
    return read;
  }
  await read.run;
  return panic("A rejected case-law search answered when read again");
};

/**
 * How long before the call's deadline each phrasing stops, so the call can
 * still answer from the phrasings that finished: merging, projecting and
 * writing the response come after the last phrasing, against the same
 * deadline.
 */
const CASE_LAW_PHRASING_ANSWER_RESERVE_MS = 1000;

/**
 * Run one phrasing's search and keep its promise: a statement the time budget
 * cancelled rejects rather than answers, and whether that rejection is this
 * phrasing's alone is decided once every phrasing has settled. Its index
 * reads queue in lane `lane` (`corpus-index-admission.ts`), so under load
 * the first phrasings finish before the last instead of all of them
 * finishing late together.
 */
export const runCaseLawPhrasing = async (
  subCursor: string | null | undefined,
  lane: number,
  start: () => Promise<Parameters<typeof readCaseLawSearchAnswer>[0]>,
): Promise<CaseLawSearchCallOutcome> => {
  if (subCursor === null) {
    return { type: "exhausted" };
  }
  const run = runInCorpusSearchLane(
    lane,
    async () =>
      await runBeforeRequestDeadline(
        {
          label: "search_case_law.phrasing",
          reserveMs: CASE_LAW_PHRASING_ANSWER_RESERVE_MS,
        },
        start,
      ),
  );
  const answered = await Result.tryPromise({
    try: async () => await run,
    catch: (cause) => cause,
  });
  return Result.isOk(answered)
    ? { type: "answered", subCursor, result: answered.value }
    : { type: "rejected", subCursor, run, error: answered.error };
};

/** The `searches[]` entry of a phrasing the time budget stopped. */
export const timedOutPhrasingNote = ({
  query,
  queryUsed,
  warnings,
}: {
  query: string;
  queryUsed: string;
  warnings: readonly AgentCaseLawSearchWarning[];
}) => ({
  query,
  queryUsed,
  paginationOutcome: SEARCH_PAGINATION_TRUNCATED_TIME_BUDGET,
  warnings: [...warnings, phrasingTimedOutWarning({ query })],
});

export const SEARCH_ADMISSION = {
  domain: "caseLaw",
  surface: "search",
} as const;

/**
 * What a phrasing reads about its result set. Aggregations are read over the
 * whole result set, beside the scan and from the same engine slots, so only a
 * call that names facets pays for them, on its first phrasing. The total is
 * read with those facets; a call that names none gets the hits alone.
 */
export const phrasingResultSet = <Facet>(
  index: number,
  facets: Facet[],
): { facets: Facet[]; describeResultSet?: false } =>
  index === 0 && facets.length > 0
    ? { facets }
    : { facets: [], describeResultSet: false };

type AnsweredPhrasingWarningsOptions = Parameters<
  typeof manyRequiredTermsWarnings
>[0] &
  PartialMatchWarningOptions & {
    query: string;
    page: { paginationOutcome: { type: string; reason?: string } };
  };

/** What a phrasing that returned a page says about that page. */
export const answeredPhrasingWarnings = ({
  query,
  subCursor,
  page,
  slots,
  merged,
  order,
  queryIndex,
  countsStrictSet,
}: AnsweredPhrasingWarningsOptions): AgentCaseLawSearchWarning[] => [
  ...(partialMatchesUnread(page.paginationOutcome)
    ? [partialMatchesUnreadWarning({ query })]
    : []),
  ...manyRequiredTermsWarnings({ subCursor, page, slots }),
  ...partialMatchWarnings({ merged, order, queryIndex, countsStrictSet }),
];

export type SearchCaseLawArgs = v.InferOutput<typeof searchCaseLawArgs>;
export type SearchCaseLawData = v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>;
export type SearchCaseLawPartial = NonNullable<
  Extract<SearchCaseLawData, { status: "running" }>["partial"]
>;

const searchCaseLawProgress = v.strictObject({
  finishedQueries: v.array(v.string()),
  pendingQueries: v.array(v.string()),
  decisions: v.array(
    v.strictObject({
      decisionId: v.string(),
      caseNumber: v.string(),
      decisionDate: v.nullable(v.string()),
    }),
  ),
});

const isSearchCaseLawPartial = (
  value: unknown,
): value is SearchCaseLawPartial =>
  v.safeParse(searchCaseLawProgress, value).success;

export type FinishedSearchCaseLawData = Exclude<
  SearchCaseLawData,
  { status: "running" }
>;

export const createCaseLawContinuation = (
  options: Pick<
    Parameters<typeof createToolContinuation>[1],
    "store" | "ownerId" | "limits" | "clock"
  > = {},
) =>
  createToolContinuation<
    typeof searchCaseLawArgs,
    FinishedSearchCaseLawData,
    SearchCaseLawPartial
  >(searchCaseLawArgs, {
    ...options,
    progress: (value) => (isSearchCaseLawPartial(value) ? value : null),
  });

export type CaseLawContinuation = ReturnType<typeof createCaseLawContinuation>;

let caseLawContinuation: CaseLawContinuation | undefined;

/** One per process, so concurrent calls on this task can find each other. */
const getCaseLawContinuation = (): CaseLawContinuation => {
  caseLawContinuation ??= createCaseLawContinuation();
  return caseLawContinuation;
};

export const caseLawContinuationFor = (context: AuthorizedMcpRequestContext) =>
  context.testDependencies?.caseLawSearchContinuation ??
  getCaseLawContinuation();

/**
 * Reports what the phrasings that finished found, while others still run. A
 * call that has every phrasing has its answer, so there is nothing to report.
 */
export const phrasingProgressReporter = (
  queries: readonly string[],
  reportProgress: (progress: SearchCaseLawPartial) => void,
) => {
  const settledPages = new Map<number, SearchCaseLawSuccess>();
  return (index: number, outcome: CaseLawSearchCallOutcome) => {
    if (outcome.type === "answered" && isSearchCaseLawSuccess(outcome.result)) {
      settledPages.set(index, outcome.result);
      if (settledPages.size < queries.length) {
        const finishedQueries: string[] = [];
        const pendingQueries: string[] = [];
        for (const [position, query] of queries.entries()) {
          (settledPages.has(position) ? finishedQueries : pendingQueries).push(
            query,
          );
        }
        reportProgress({
          finishedQueries,
          pendingQueries,
          decisions: mergeCaseLawSearchHits(
            [...settledPages.values()].map(({ hits }) => hits),
            mergedCaseLawHitOrder(
              [...settledPages.values()].map((page) => ({
                type: "page" as const,
                page,
              })),
            ),
          ).map(({ hit }) => ({
            decisionId: hit.decisionId,
            caseNumber: hit.caseNumber,
            decisionDate: hit.decisionDate,
          })),
        });
      }
    }
  };
};

export const stoppedOnTimeBudget = (
  outcome: { type: string; reason?: string } | undefined,
): boolean =>
  outcome !== undefined &&
  ((outcome.type === SEARCH_PAGINATION_TRUNCATED_TIME_BUDGET.type &&
    outcome.reason === SEARCH_PAGINATION_TRUNCATED_TIME_BUDGET.reason) ||
    partialMatchesUnread(outcome));
