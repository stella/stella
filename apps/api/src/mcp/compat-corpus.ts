import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  type PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  PUBLIC_LEGISLATION_COUNTRIES,
  type PublicLegislationCountry,
} from "@stll/api-contract/legislation-publication";
import { mapWithConcurrency } from "@stll/concurrency";
import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { DECISION_DOCUMENT_HYDRATION } from "@/api/handlers/case-law/decisions/get-deferred-document";
import { parseUsableDocumentAst } from "@/api/handlers/case-law/document-ast";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { encodeCompatId } from "@/api/mcp/compat-ids";
import type { McpRequestContext } from "@/api/mcp/context";
import { loadPracticeJurisdictions } from "@/api/mcp/practice-jurisdictions";
import {
  defaultReadGatedDecisionWithDocument,
  defaultReadPublicLegislationHandler,
  defaultResolveStatuteExpression,
  defaultSearchDecisionsHandler,
  defaultSearchLegislationHandler,
  isLegislationSearchSuccess,
  isReadCaseLawDecisionSuccess,
  isSearchCaseLawSuccess,
  isStatuteDocument,
} from "@/api/mcp/public-law-handlers";
import type { McpCompatSearchResult } from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionUrl,
  buildLegislationDocumentAppUrl,
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

/**
 * One corpus source's position, keyed by country. A key absent means that
 * country has not been asked yet (its first page); a key holding `null` means
 * its pages ended on an earlier call and it is not asked again.
 */
export type CorpusSubCursors = Readonly<Record<string, string | null>>;

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
 * Which corpus countries a query is about.
 *
 * The organization's practice jurisdictions are the only jurisdiction signal
 * this pair has, so they select from what the corpus admits. An organization
 * that has not set any has not said it practises nowhere: it gets every
 * admitted country. One that practises only where this corpus holds nothing
 * gets no corpus hits, which is the same answer the named tools give it.
 */
export const resolveCompatCorpusCountries = async (
  context: McpRequestContext,
): Promise<CompatCorpusCountries> => {
  const practised: ReadonlySet<string> = new Set(
    (await loadPracticeJurisdictions(context)).flatMap(({ countryCode }) => {
      // The column stores alpha-2 and the corpus keys on alpha-3; the shared
      // country reader is what converts between them everywhere else too.
      const normalized = normalizeCountry(countryCode, { spelling: "alpha-3" });
      return normalized.ok ? [normalized.value.alpha3] : [];
    }),
  );

  const admitted = <TCountry extends string>(
    countries: readonly TCountry[],
  ): readonly TCountry[] =>
    practised.size === 0
      ? countries
      : countries.filter((country) => practised.has(country));

  return {
    caseLaw: admitted(PUBLIC_CASE_LAW_COUNTRIES),
    legislation: admitted(PUBLIC_LEGISLATION_COUNTRIES),
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
};

type CorpusPageOutcome =
  | { type: "page"; page: CorpusPage }
  | { type: "failed"; message: string };

const EMPTY_PAGE: CorpusPage = { results: [], cursors: {} };

/**
 * A source's page cap split across the countries it is asked for, summing to
 * exactly the cap: a floor share each, plus one extra hit to the first
 * `cap % countries` of them in admitted order.
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

/**
 * Three states, as in `search_case_law`: a string continues this country, an
 * absent entry is its first page, and `null` means it ended on an earlier one.
 */
const subCursorArgument = (
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

const searchDecisions = async ({
  context,
  countries,
  cursors,
  query,
}: {
  context: McpRequestContext;
  countries: readonly PublicCaseLawCountry[];
  cursors: CorpusSubCursors;
  query: string;
}): Promise<CorpusPageOutcome> => {
  if (countries.length === 0) {
    return { type: "page", page: EMPTY_PAGE };
  }
  const search =
    context.testDependencies?.searchDecisionsHandler ??
    defaultSearchDecisionsHandler;

  const outcomes = await mapWithConcurrency({
    items: [
      ...corpusCountryQuotas(
        LIMITS.mcpCompatDecisionPageSizeDefault,
        countries,
      ),
    ],
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
        result: await search(
          {
            query,
            limit,
            country,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
          },
          caseLawPublicReadDb,
        ),
      } as const;
    },
  });

  const page: CorpusPage = { results: [], cursors: {} };
  for (const { country, result } of outcomes) {
    if (result === null) {
      page.cursors[country] = null;
      continue;
    }
    // A country that failed sinks the corpus half rather than reading as "no
    // law there": those are different answers to the same question.
    if (!isSearchCaseLawSuccess(result)) {
      return { type: "failed", message: "Case-law search failed" };
    }
    page.cursors[country] = result.nextCursor;
    for (const hit of result.hits) {
      page.results.push({
        kind: "corpus",
        id: encodeCompatId({ kind: "decision", decisionId: hit.decisionId }),
        title: caseLawDecisionHeading({
          caseNumber: hit.caseNumber,
          court: hit.court,
        }),
        url: buildCaseLawDecisionUrl({
          caseNumber: hit.caseNumber,
          country: hit.country,
          court: hit.court,
          decisionId: hit.decisionId,
          language: hit.language,
          languageAlternates: hit.languageAlternates,
          slug: hit.slug,
        }),
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
  context: McpRequestContext;
  countries: readonly PublicLegislationCountry[];
  cursors: CorpusSubCursors;
  query: string;
}): Promise<CorpusPageOutcome> => {
  if (countries.length === 0) {
    return { type: "page", page: EMPTY_PAGE };
  }
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
        ),
      } as const;
    },
  });

  const page: CorpusPage = { results: [], cursors: {} };
  for (const { jurisdiction, result } of outcomes) {
    if (result === null) {
      page.cursors[jurisdiction] = null;
      continue;
    }
    if (!isLegislationSearchSuccess(result)) {
      return { type: "failed", message: "Legislation search failed" };
    }
    page.cursors[jurisdiction] = result.nextCursor;
    for (const hit of result.items) {
      // A statute whose ELI mints no slug has no address in the app; the
      // publisher's own is then the one address there is, and a hit with
      // neither is dropped rather than answered with an empty url.
      const url =
        buildLegislationDocumentAppUrl({
          country: hit.country,
          eli: hit.eli,
          title: hit.title,
        }) ?? hit.sourceUrl;
      if (url === null) {
        continue;
      }
      page.results.push({
        kind: "corpus",
        id: encodeCompatId({ kind: "statute", eli: hit.eli }),
        title: hit.title,
        url,
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
    }
  | { type: "failed"; message: string };

/**
 * One page of the corpus for a compat `search`: decisions first, then
 * statutes. The order is the ranking, and it is fixed rather than scored
 * across corpora: a relevance number from the case-law index and one from the
 * legislation index are not comparable, so a merge that sorted on them would
 * be inventing an order. A question that names an act is answered by its
 * statute hits being present, not by their being first.
 */
export const searchCompatCorpus = async ({
  context,
  countries,
  cursors,
  query,
}: {
  context: McpRequestContext;
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
    cursors: {
      decisions: decisions.page.cursors,
      statutes: statutes.page.cursors,
    },
  };
};

/** Whether any corpus source can still answer a further page. */
export const hasMoreCorpusPages = (cursors: CompatCorpusCursors): boolean =>
  [
    ...Object.values(cursors.decisions),
    ...Object.values(cursors.statutes),
  ].some((cursor) => cursor !== null);

export type CompatCorpusRead =
  | { type: "read"; text: string; title: string; url: string }
  | { type: "not_found" }
  | { type: "withheld"; url: string };

/**
 * One decision, read through the same gate the public route applies: a
 * restricted decision does not exist for any caller, and a source cleared for
 * display but not for AI use answers `withheld` rather than with its wording.
 */
export const readCompatDecision = async ({
  context,
  decisionId,
}: {
  context: McpRequestContext;
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
    documentHydration: DECISION_DOCUMENT_HYDRATION.onDemand,
  });
  if (decision === null || !isReadCaseLawDecisionSuccess(decision)) {
    return { type: "not_found" };
  }

  const url = buildCaseLawDecisionUrl({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });
  if (!decision.source.allowsDerivedAi) {
    return { type: "withheld", url };
  }

  return {
    type: "read",
    text:
      toPlainCorpusText({
        blocks: parseUsableDocumentAst(decision.documentAst)?.blocks ?? null,
        fulltext: decision.fulltext,
      }) ?? "",
    title: caseLawDecisionHeading({
      caseNumber: decision.caseNumber,
      court: decision.court,
    }),
    url,
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
  context: McpRequestContext;
  eli: string;
}): Promise<CompatCorpusRead> => {
  const resolved = await (
    context.testDependencies?.resolveStatuteExpression ??
    defaultResolveStatuteExpression
  )({ eli }, legislationPublicReadDb);
  if (resolved.type !== "expression") {
    return { type: "not_found" };
  }

  const document = await (
    context.testDependencies?.readPublicLegislationHandler ??
    defaultReadPublicLegislationHandler
  )(resolved.id, legislationPublicReadDb);
  if (!isStatuteDocument(document)) {
    return { type: "not_found" };
  }

  const url =
    buildLegislationDocumentAppUrl({
      country: document.country,
      eli: document.eli,
      slug: document.slug,
      title: document.title,
    }) ?? document.sourceUrl;
  if (!document.allowsDerivedAi) {
    return { type: "withheld", url: url ?? "" };
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
    url: url ?? "",
  };
};
