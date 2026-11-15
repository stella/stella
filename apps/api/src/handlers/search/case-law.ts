import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import {
  CASE_LAW_COUNTRIES_CURSOR_MAX_LENGTH,
  type CaseLawCountrySearch,
  type CaseLawSearchHit,
  decodeCaseLawCountriesCursor,
  encodeCaseLawCountriesCursor,
  hasMoreCountryPages,
  practisedCaseLawCountries,
  practisedCorpusCountries,
  searchCaseLawCountries,
} from "@/api/lib/legal-search/case-law-multi-country";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { globalSearchIdentity } from "@/api/lib/search/resource-search";
import type { CaseLawGlobalSearchHit } from "@/api/lib/search/types";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";

/**
 * The search palette's case-law section.
 *
 * Global search (`POST /v1/search`) answers the caller's own matters; case
 * law is the public corpus, and the corpus has one search engine: the
 * per-country case-law search behind `search_case_law` and
 * `POST /v1/case/decisions/search`. This route asks that engine once per
 * country the organization practises in (every admitted country when it has
 * recorded none) and answers in the global-search hit shape, so the palette
 * lists, previews and opens a decision exactly as it does any other hit.
 */

export const searchCaseLawSectionBodySchema = v.object({
  query: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
  cursor: v.optional(
    paginationCursorSchema({ maxChars: CASE_LAW_COUNTRIES_CURSOR_MAX_LENGTH }),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.searchCaseLawSectionPageSizeMax),
    ),
    LIMITS.searchCaseLawSectionPageSizeDefault,
  ),
});

type SearchCaseLawSectionBody = v.InferOutput<
  typeof searchCaseLawSectionBodySchema
>;

/** A corpus hit in the shape every global-search hit has. */
const toCaseLawSectionHit = (
  hit: CaseLawSearchHit,
): CaseLawGlobalSearchHit => ({
  ...globalSearchIdentity(
    resourceRef({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      id: brandPersistedCaseLawDecisionId(hit.decisionId),
    }),
  ),
  id: `case-law:${hit.decisionId}`,
  type: "case-law",
  courtAbbreviation: hit.courtAbbreviation,
  decisionId: hit.decisionId,
  caseNumber: hit.caseNumber,
  identifiers: hit.identifiers,
  court: hit.court,
  country: hit.country,
  decisionDate: hit.decisionDate,
  slug: hit.slug,
  language: hit.language,
  // One entry per language: a hit only needs to know whether to name its
  // language, so the rest of each version stays off the wire.
  languageAlternates: hit.languageAlternates.map(({ language }) => ({
    language,
  })),
  title: `${hit.caseNumber} - ${hit.court}`,
  // Escaped and `<mark>`-highlighted by the case-law search response.
  headline: hit.headline,
  updatedAt: hit.createdAt,
});

type SearchCaseLawSectionOptions = {
  body: SearchCaseLawSectionBody;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  signal?: AbortSignal | undefined;
  search?: CaseLawCountrySearch;
  loadJurisdictions?: typeof loadPracticeJurisdictions;
};

export const searchCaseLawSectionHandler = async ({
  body,
  organizationId,
  scopedDb,
  signal,
  search,
  loadJurisdictions = loadPracticeJurisdictions,
}: SearchCaseLawSectionOptions) => {
  const cursors =
    body.cursor === undefined ? {} : decodeCaseLawCountriesCursor(body.cursor);
  if (cursors === null) {
    return status(400, { message: "Invalid cursor" });
  }

  const countries = practisedCaseLawCountries(
    practisedCorpusCountries(
      await loadJurisdictions({ scopedDb, organizationId }),
    ),
  );
  const outcome = await searchCaseLawCountries({
    query: body.query,
    countries,
    cursors,
    // Every asked country gets at least one hit per page, or one whose share
    // floored to zero would never be asked on any later page either.
    cap: Math.max(body.limit, countries.length),
    observer: actionRequestObserver(
      organizationId,
      ACTION_COST_CALL_KIND.corpusRequest,
    ),
    signal,
    ...(search === undefined ? {} : { search }),
  });
  if (outcome.type === "failed") {
    // The country's own refusal (a timeout, an unavailable index), not an
    // empty section: no case law and unanswered are different answers.
    return outcome.answer;
  }

  return {
    hits: outcome.countries.flatMap(({ hits }) =>
      hits.map(toCaseLawSectionHit),
    ),
    nextCursor: hasMoreCountryPages(outcome.cursors)
      ? encodeCaseLawCountriesCursor(outcome.cursors)
      : null,
  };
};

/** `POST /v1/search/case-law`: the palette's case-law section. */
const searchCaseLawSection = createSafeRootHandler(
  {
    contract: "patch",
    access: "read",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "search_ui" },
    body: searchCaseLawSectionBodySchema,
  } satisfies HandlerConfig,
  async function* ({ body, request, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchCaseLawSectionHandler({
            body,
            organizationId: session.activeOrganizationId,
            scopedDb,
            signal: request.signal,
          }),
      ),
    );

    return Result.ok(response);
  },
);

declareAggregateMutation(searchCaseLawSection, {
  type: "independent",
  reason:
    "Writes nothing: a search body, posted like the other palette searches.",
});

export default searchCaseLawSection;
