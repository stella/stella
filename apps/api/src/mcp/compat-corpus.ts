import { panic } from "better-result";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  type PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  PUBLIC_LEGISLATION_COUNTRIES,
  type PublicLegislationCountry,
} from "@stll/api-contract/legislation-publication";
import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  type SearchPaginationOutcome,
} from "@stll/api-contract/search";
import { mapWithConcurrency } from "@stll/concurrency";
import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { documentHydrationFor } from "@/api/handlers/case-law/decisions/get-deferred-document";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
import { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import {
  corpusCountryQuotas,
  type CorpusSubCursors,
  practisedCorpusCountries,
  rankCorpusCountries,
  searchCaseLawCountries,
  subCursorArgument,
} from "@/api/lib/legal-search/case-law-multi-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";
import { encodeCompatId } from "@/api/mcp/compat-ids";
import type { McpRequestResources } from "@/api/mcp/context";
import {
  defaultReadGatedDecisionWithDocument,
  defaultReadPublicLegislationHandler,
  defaultResolveStatuteExpression,
  defaultSearchDecisionsHandler,
  defaultSearchLegislationHandler,
  isLegislationSearchSuccess,
  isReadCaseLawDecisionSuccess,
  isStatuteDocument,
} from "@/api/mcp/public-law-handlers";
import {
  createToolContinuation,
  waitForPublicRead,
} from "@/api/mcp/public-read-continuation";
import type {
  InternalToolErrorResult,
  McpCompatSearchResult,
} from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionAppUrl,
  buildLegislationDocumentAppUrl,
  errorResult,
  legalCitationLinkFields,
  searchRefusalResult,
  toolDataResult,
  toPlainCorpusText,
} from "@/api/mcp/tool-utils";

/**
 * The public legal corpus behind the OpenAI-compatible `search`/`fetch` pair.
 *
 * That pair takes a query and nothing else: no country, no corpus, no filters.
 * Everything the named corpus tools take as an argument is therefore decided
 * here, from the organization's own settings and from the corpus's admission
 * lists, and every read goes through the same handlers `search_case_law`,
 * `read_case_law_decision`, `search_legislation` and `read_statute` use. There
 * is one search path per corpus, not a second one for this pair.
 *
 * Nothing in this module reads matter data, so both audiences that serve the
 * pair share it unchanged.
 */

export type CompatCorpusCursors = {
  decisions: CorpusSubCursors;
  statutes: CorpusSubCursors;
};

export const EMPTY_CORPUS_CURSORS: CompatCorpusCursors = {
  decisions: {},
  statutes: {},
};

export type CompatCorpusCountries = {
  caseLaw: readonly PublicCaseLawCountry[];
  legislation: readonly PublicLegislationCountry[];
};

/**
 * The corpus countries a query is asked of: every admitted country, ranked by
 * the organization's practice jurisdictions (the only jurisdiction signal this
 * pair has).
 *
 * Practice jurisdictions order the countries and never remove one. This pair
 * takes a query and a cursor and nothing else, so a country it left out could
 * not be asked for from here: an organization practising only where the
 * corpus holds nothing would get no corpus hits and no way to change that,
 * and one practising in a single country would never see the rest, with
 * nothing in the answer saying so. Ranking keeps the signal without that dead
 * end: the countries asked are exactly the admitted ones for every
 * organization, and the practised ones lead. Their lead is the result order
 * (hits are merged in country order) and the page-cap remainder
 * (`corpusCountryQuotas` gives the extra hits to the first countries), so a
 * practised country is also never given a smaller share than an unpractised
 * one. The per-country quota floor stays one hit, which the cap assertion
 * below guarantees for every admitted country.
 */
export const resolveCompatCorpusCountries = async (
  context: McpRequestResources,
): Promise<CompatCorpusCountries> => {
  const practised = practisedCorpusCountries(
    await loadPracticeJurisdictions(context),
  );

  return {
    caseLaw: rankCorpusCountries(PUBLIC_CASE_LAW_COUNTRIES, practised),
    legislation: rankCorpusCountries(PUBLIC_LEGISLATION_COUNTRIES, practised),
  };
};

/**
 * A decision's heading: the court that decided it and the docket it decided
 * under. Minted once, so the title a `search` hit carries and the title its
 * `fetch` answers with are the same string.
 */
const caseLawDecisionHeading = ({
  caseNumber,
  court,
}: {
  caseNumber: string;
  court: string;
}): string =>
  court.trim().length === 0 ? caseNumber : `${court.trim()} ${caseNumber}`;

type CorpusPage = {
  results: McpCompatSearchResult[];
  cursors: Record<string, string | null>;
  paginationOutcome: SearchPaginationOutcome;
};

type CorpusPageOutcome =
  | { type: "page"; page: CorpusPage }
  | { type: "failed"; result: InternalToolErrorResult };

const EMPTY_PAGE: CorpusPage = {
  results: [],
  cursors: {},
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
};

/**
 * A country whose share floors to zero would have to be carried to a later
 * page, and this pair has no scheme for that: its merged cursor records where
 * each country got to, not which ones never ran. Both admitted lists and both
 * caps are constants, so the case is excluded here rather than handled: an
 * admission that outgrows its cap fails at module load, on the deployment that
 * made the change, instead of silently dropping a jurisdiction from `search`.
 */
const assertCapCoversAdmittedCountries = (
  source: string,
  cap: number,
  admitted: readonly string[],
): void => {
  if (admitted.length > cap) {
    panic(
      `The ${source} compat page cap is smaller than the admitted country list`,
      { admitted: admitted.length, cap },
    );
  }
};

assertCapCoversAdmittedCountries(
  "case-law",
  LIMITS.mcpCompatDecisionPageSizeDefault,
  PUBLIC_CASE_LAW_COUNTRIES,
);
assertCapCoversAdmittedCountries(
  "legislation",
  LIMITS.mcpCompatStatutePageSizeDefault,
  PUBLIC_LEGISLATION_COUNTRIES,
);

const searchDecisions = async ({
  context,
  countries,
  cursors,
  query,
}: {
  context: McpRequestResources;
  countries: readonly PublicCaseLawCountry[];
  cursors: CorpusSubCursors;
  query: string;
}): Promise<CorpusPageOutcome> => {
  const outcome = await searchCaseLawCountries({
    query,
    countries,
    cursors,
    cap: LIMITS.mcpCompatDecisionPageSizeDefault,
    observer: actionRequestObserver(
      context.organizationId,
      ACTION_COST_CALL_KIND.corpusRequest,
    ),
    search:
      context.testDependencies?.searchDecisionsHandler ??
      defaultSearchDecisionsHandler,
  });
  if (outcome.type === "failed") {
    return {
      type: "failed",
      result:
        searchRefusalResult(outcome.answer) ??
        errorResult("Case-law search failed"),
    };
  }

  const page: CorpusPage = {
    results: [],
    cursors: outcome.cursors,
    paginationOutcome: outcome.paginationOutcome,
  };
  for (const { hits } of outcome.countries) {
    for (const hit of hits) {
      const links = legalCitationLinkFields({
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
      });
      if (links.url === null) {
        continue;
      }
      page.results.push({
        kind: "corpus",
        id: encodeCompatId({ kind: "decision", decisionId: hit.decisionId }),
        title: caseLawDecisionHeading({
          caseNumber: hit.caseNumber,
          court: hit.court,
        }),
        url: links.url,
        ...(links.source_url === undefined
          ? {}
          : { source_url: links.source_url }),
      });
    }
  }
  return { type: "page", page };
};

const searchStatutes = async ({
  context,
  countries,
  cursors,
  query,
}: {
  context: McpRequestResources;
  countries: readonly PublicLegislationCountry[];
  cursors: CorpusSubCursors;
  query: string;
}): Promise<CorpusPageOutcome> => {
  if (countries.length === 0) {
    return { type: "page", page: EMPTY_PAGE };
  }
  const observer = actionRequestObserver(
    context.organizationId,
    ACTION_COST_CALL_KIND.corpusRequest,
  );
  const search =
    context.testDependencies?.searchLegislationHandler ??
    defaultSearchLegislationHandler;

  const outcomes = await mapWithConcurrency({
    items: [
      ...corpusCountryQuotas(
        LIMITS.mcpCompatStatutePageSizeDefault,
        countries,
      ).map(({ country, limit }) => ({ jurisdiction: country, limit })),
    ],
    limit: countries.length,
    operation: async ({
      jurisdiction,
      limit,
    }: {
      jurisdiction: PublicLegislationCountry;
      limit: number;
    }) => {
      const position = subCursorArgument(cursors, jurisdiction);
      if (position.exhausted) {
        return { jurisdiction, result: null } as const;
      }
      return {
        jurisdiction,
        result: await search(
          {
            query,
            limit,
            jurisdiction,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
          },
          legislationPublicReadDb,
          observer,
        ),
      } as const;
    },
  });

  const page: CorpusPage = {
    results: [],
    cursors: {},
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  };
  for (const { jurisdiction, result } of outcomes) {
    if (result === null) {
      page.cursors[jurisdiction] = null;
      continue;
    }
    const refusal = searchRefusalResult(result);
    if (refusal !== null) {
      return { type: "failed", result: refusal };
    }
    if (!isLegislationSearchSuccess(result)) {
      return {
        type: "failed",
        result: errorResult("Legislation search failed"),
      };
    }
    page.cursors[jurisdiction] = result.nextCursor;
    if (result.paginationOutcome.type === "truncated") {
      page.paginationOutcome = result.paginationOutcome;
    }
    for (const hit of result.items) {
      // With the public-law surface off there is no address in the app; the
      // publisher's own is then the one address there is, and a hit with
      // neither is dropped rather than answered with an empty url.
      const links = legalCitationLinkFields({
        url: buildLegislationDocumentAppUrl({
          country: hit.country,
          documentId: hit.documentId,
          eli: hit.eli,
          slug: hit.slug,
        }),
        sourceUrl: hit.sourceUrl,
      });
      const { url } = links;
      if (url === null) {
        continue;
      }
      page.results.push({
        kind: "corpus",
        id: encodeCompatId({ kind: "statute", eli: hit.eli }),
        title: hit.title,
        url,
        ...(links.source_url === undefined
          ? {}
          : { source_url: links.source_url }),
      });
    }
  }
  return { type: "page", page };
};

export type CompatCorpusSearchOutcome =
  | {
      type: "page";
      results: readonly McpCompatSearchResult[];
      cursors: CompatCorpusCursors;
      paginationOutcome: SearchPaginationOutcome;
    }
  | { type: "failed"; result: InternalToolErrorResult };

/**
 * One page of the corpus for a compat `search`: decisions first, then
 * statutes. The order is the ranking, and it is fixed rather than scored
 * across corpora: a relevance number from the case-law index and one from the
 * legislation index are not comparable, so a merge that sorted on them would
 * be inventing an order. A question that names an act is answered by its
 * statute hits being present, not by their being first.
 */
const searchCompatCorpus = async ({
  context,
  countries,
  cursors,
  query,
}: {
  context: McpRequestResources;
  countries: CompatCorpusCountries;
  cursors: CompatCorpusCursors;
  query: string;
}): Promise<CompatCorpusSearchOutcome> => {
  const [decisions, statutes] = await Promise.all([
    searchDecisions({
      context,
      countries: countries.caseLaw,
      cursors: cursors.decisions,
      query,
    }),
    searchStatutes({
      context,
      countries: countries.legislation,
      cursors: cursors.statutes,
      query,
    }),
  ]);
  if (decisions.type === "failed") {
    return decisions;
  }
  if (statutes.type === "failed") {
    return statutes;
  }

  return {
    type: "page",
    results: [...decisions.page.results, ...statutes.page.results],
    paginationOutcome:
      decisions.page.paginationOutcome.type === "truncated" ||
      statutes.page.paginationOutcome.type === "truncated"
        ? SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET
        : SEARCH_PAGINATION_COMPLETE,
    cursors: {
      decisions: decisions.page.cursors,
      statutes: statutes.page.cursors,
    },
  };
};

/** How long `search` waits on the server for a continued corpus read. */
const COMPAT_CORPUS_WAIT_MS = 25_000;

const compatSubCursors = v.record(v.string(), v.nullable(v.string()));

const compatCorpusWorkArgs = v.strictObject({
  countries: v.strictObject({
    caseLaw: v.array(v.picklist(PUBLIC_CASE_LAW_COUNTRIES)),
    legislation: v.array(v.picklist(PUBLIC_LEGISLATION_COUNTRIES)),
  }),
  cursors: v.strictObject({
    decisions: compatSubCursors,
    statutes: compatSubCursors,
  }),
  query: v.string(),
});

type CompatCorpusPage = Omit<
  Extract<CompatCorpusSearchOutcome, { type: "page" }>,
  "type"
>;

export const createCompatCorpusContinuation = (
  options: Pick<
    Parameters<typeof createToolContinuation>[1],
    "store" | "ownerId" | "limits" | "clock"
  > = {},
) =>
  createToolContinuation<typeof compatCorpusWorkArgs, CompatCorpusPage, null>(
    compatCorpusWorkArgs,
    { ...options, progress: () => null },
  );

export type CompatCorpusContinuation = ReturnType<
  typeof createCompatCorpusContinuation
>;

let compatCorpusContinuation: CompatCorpusContinuation | undefined;

/** One per process, so concurrent calls on this task can find each other. */
const getCompatCorpusContinuation = (): CompatCorpusContinuation => {
  compatCorpusContinuation ??= createCompatCorpusContinuation();
  return compatCorpusContinuation;
};

type WaitForCompatCorpusOptions = {
  context: McpRequestResources;
  countries: CompatCorpusCountries;
  cursors: CompatCorpusCursors;
  query: string;
};

/** The corpus half of `search`, continued like the other public searches. */
export const waitForCompatCorpus = async ({
  context,
  countries,
  cursors,
  query,
}: WaitForCompatCorpusOptions): Promise<
  CompatCorpusSearchOutcome | { type: "still_running" }
> => {
  const waited = await waitForPublicRead({
    toolName: "search",
    continuation:
      context.testDependencies?.compatCorpusContinuation ??
      getCompatCorpusContinuation(),
    args: {
      countries: {
        caseLaw: [...countries.caseLaw],
        legislation: [...countries.legislation],
      },
      cursors,
      query,
    },
    context,
    waitMs: COMPAT_CORPUS_WAIT_MS,
    execute: async (workArgs) => {
      const outcome = await searchCompatCorpus({ context, ...workArgs });
      return outcome.type === "failed"
        ? outcome.result
        : toolDataResult({
            results: [...outcome.results],
            cursors: outcome.cursors,
            paginationOutcome: outcome.paginationOutcome,
          });
    },
  });
  if (waited.type === "still_running") {
    return waited;
  }
  return waited.result.status === "error"
    ? { type: "failed", result: waited.result }
    : { type: "page", ...waited.result.data };
};

/** Whether any corpus source can still answer a further page. */
export const hasMoreCorpusPages = (cursors: CompatCorpusCursors): boolean =>
  [
    ...Object.values(cursors.decisions),
    ...Object.values(cursors.statutes),
  ].some((cursor) => cursor !== null);

export type CompatCorpusRead =
  | {
      type: "read";
      text: string;
      title: string;
      url: string;
      source_url?: string;
    }
  | { type: "not_found" }
  | { type: "withheld"; url: string; source_url?: string };

/**
 * One decision, read through the same gate the public route applies: a
 * restricted decision does not exist for any caller, and a source cleared for
 * display but not for AI use answers `withheld` rather than with its wording.
 */
export const readCompatDecision = async ({
  context,
  decisionId,
}: {
  context: McpRequestResources;
  decisionId: string;
}): Promise<CompatCorpusRead> => {
  const read =
    context.testDependencies?.readGatedDecisionWithDocument ??
    defaultReadGatedDecisionWithDocument;
  const decision = await read({
    caseLawDb: caseLawPublicReadDb,
    locator: { kind: "id", id: brandPersistedCaseLawDecisionId(decisionId) },
    citationsCursor: undefined,
    // An agent holding a token is a reader we can attribute, so its interest
    // counts as demand for the publisher document.
    caller: "attributed",
    documentHydration: documentHydrationFor(context.thirdPartyOutboundPermit),
    surface: "search",
  });
  if (decision === null || !isReadCaseLawDecisionSuccess(decision)) {
    return { type: "not_found" };
  }

  const links = legalCitationLinkFields({
    url: buildCaseLawDecisionAppUrl({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    }),
    sourceUrl: decision.sourceUrl,
  });
  const { url, source_url } = links;
  if (url === null) {
    return { type: "not_found" };
  }
  if (!decision.source.allowsDerivedAi) {
    return {
      type: "withheld",
      url,
      ...(source_url === undefined ? {} : { source_url }),
    };
  }

  return {
    type: "read",
    text:
      toPlainCorpusText({
        blocks: parseCachedDecisionAst(decision.documentAst)?.blocks ?? null,
        fulltext: decision.fulltext,
      }) ?? "",
    title: caseLawDecisionHeading({
      caseNumber: decision.caseNumber,
      court: decision.court,
    }),
    url,
    ...(source_url === undefined ? {} : { source_url }),
  };
};

/**
 * One statute's current consolidation, addressed by the ELI `read_statute`
 * accepts and resolved by the one resolver the public routes share.
 */
export const readCompatStatute = async ({
  context,
  eli,
}: {
  context: McpRequestResources;
  eli: string;
}): Promise<CompatCorpusRead> => {
  const resolved = await (
    context.testDependencies?.resolveStatuteExpression ??
    defaultResolveStatuteExpression
  )({ eli }, legislationPublicReadDb, "search");
  if (resolved.type !== "expression") {
    return { type: "not_found" };
  }

  const document = await (
    context.testDependencies?.readPublicLegislationHandler ??
    defaultReadPublicLegislationHandler
  )(resolved.id, legislationPublicReadDb, "search");
  if (!isStatuteDocument(document)) {
    return { type: "not_found" };
  }

  const links = legalCitationLinkFields({
    url: buildLegislationDocumentAppUrl({
      country: document.country,
      documentId: document.id,
      eli: document.eli,
      slug: document.slug,
    }),
    sourceUrl: document.sourceUrl,
  });
  const { url, source_url } = links;
  if (url === null) {
    return { type: "not_found" };
  }
  if (!document.allowsDerivedAi) {
    return {
      type: "withheld",
      url,
      ...(source_url === undefined ? {} : { source_url }),
    };
  }

  return {
    type: "read",
    text:
      toPlainCorpusText({
        blocks: hasUsableAst(document.documentAst)
          ? document.documentAst.blocks
          : null,
        fulltext: document.fulltext,
      }) ?? "",
    title: document.title,
    url,
    ...(source_url === undefined ? {} : { source_url }),
  };
};
