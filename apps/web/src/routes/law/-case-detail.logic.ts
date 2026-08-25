import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import * as v from "valibot";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import {
  decisionCitationsInfiniteOptions,
  decisionCitationSummaryOptions,
} from "@/features/case-law/queries/citations";
import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { decisionProvisionsInfiniteOptions } from "@/features/case-law/queries/provisions";
import { getAnalytics } from "@/lib/analytics/provider";
import { createCaseLawLanguageAlternateLinks } from "@/lib/case-law-language-alternates";
import {
  type CaseLawDecisionRouteParams,
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
  extractCaseLawDecisionIdFromIdRouteParam,
  normalizeCaseLawLanguageSegment,
} from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createCaseLawDecisionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import {
  ensureRouteQueryData,
  prefetchNonCriticalInfiniteQuery,
  prefetchNonCriticalQuery,
  routeQueryOptions,
} from "@/lib/react-query";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

const optionalPublicDecisionSearchQuerySchema = v.optional(
  v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(512),
    v.transform((value) => (value.length > 0 ? value : undefined)),
  ),
);

export const publicDecisionSearchSchema = v.object({
  q: optionalPublicDecisionSearchQuerySchema,
});

export type PublicDecisionSearch = v.InferOutput<
  typeof publicDecisionSearchSchema
>;

export type PublicDecisionRouteParams = CaseLawDecisionRouteParams;

type PublicDecisionRouteLoaderOptions = {
  params: PublicDecisionRouteParams;
  queryClient: QueryClient;
  search: PublicDecisionSearch;
};

type PublicDecisionHeadOptions = {
  decision: PublicCaseLawDecision;
  params: PublicDecisionRouteParams;
};

export type {
  PublicCaseLawDecision,
  PublicDecisionLanguageAlternate,
} from "@/features/case-law/public-decision";

type PublicLawAlternateLink = {
  href: string;
  hreflang: string;
};

type RedirectToCanonicalDecisionPathOptions = {
  canonicalParams: CaseLawDecisionRouteParams;
  search: PublicDecisionSearch;
};

export const extractId = (param: string): SafeId<"caseLawDecision"> =>
  toSafeId<"caseLawDecision">(param);

/**
 * Warm the decision's provision references and citation graph alongside
 * the decision itself.
 *
 * The panels that read them are secondary to the text, so none of this
 * blocks the route: it starts during navigation and each panel takes
 * whatever is warm by the time it renders.
 */
const primeDecisionProvisions = (
  queryClient: QueryClient,
  decisionId: string,
): void => {
  const captureError = (error: unknown) => {
    getAnalytics().captureError(error);
  };
  detached(
    prefetchNonCriticalInfiniteQuery(
      queryClient,
      routeQueryOptions(decisionProvisionsInfiniteOptions(decisionId)),
      captureError,
    ),
    "case-law.provisions-prefetch",
  );
  detached(
    prefetchNonCriticalQuery(
      queryClient,
      routeQueryOptions(decisionCitationSummaryOptions(decisionId)),
      captureError,
    ),
    "case-law.citation-summary-prefetch",
  );
  detached(
    prefetchNonCriticalInfiniteQuery(
      queryClient,
      routeQueryOptions(
        decisionCitationsInfiniteOptions(decisionId, "incoming"),
      ),
      captureError,
    ),
    "case-law.citations-incoming-prefetch",
  );
  detached(
    prefetchNonCriticalInfiniteQuery(
      queryClient,
      routeQueryOptions(
        decisionCitationsInfiniteOptions(decisionId, "outgoing"),
      ),
      captureError,
    ),
    "case-law.citations-outgoing-prefetch",
  );
};

const buildDescription = (decision: {
  caseNumber: string;
  court: string;
  country: string;
  decisionDate: Date | string | null;
}) =>
  [decision.caseNumber, decision.court, decision.decisionDate, decision.country]
    .filter(Boolean)
    .join(", ");

const ensurePublicDecision = async <T>(load: () => Promise<T>): Promise<T> => {
  try {
    return await load();
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      throw redirect({
        to: "/law/cases",
        search: { notFound: true },
        replace: true,
      });
    }
    throw error;
  }
};

const redirectToCanonicalDecisionPath = ({
  canonicalParams,
  search,
}: RedirectToCanonicalDecisionPathOptions) => {
  const redirectSearch: PublicDecisionSearch =
    search.q === undefined ? {} : { q: search.q };

  if (canonicalParams.language) {
    throw redirect({
      to: "/law/$country/cases/$court/$language/$slug",
      params: {
        country: canonicalParams.country,
        court: canonicalParams.court,
        language: canonicalParams.language,
        slug: canonicalParams.slug,
      },
      replace: true,
      search: redirectSearch,
    });
  }

  throw redirect({
    to: "/law/$country/cases/$court/$slug",
    params: {
      country: canonicalParams.country,
      court: canonicalParams.court,
      slug: canonicalParams.slug,
    },
    replace: true,
    search: redirectSearch,
  });
};

const createDecisionAlternateLinks = (
  decision: PublicCaseLawDecision,
): PublicLawAlternateLink[] =>
  createCaseLawLanguageAlternateLinks({
    alternates: decision.languageAlternates,
    createHref: (alternate) => {
      const params = createCaseLawDecisionRouteParams({
        caseNumber: alternate.caseNumber,
        country: alternate.country,
        court: alternate.court,
        decisionId: alternate.id,
        language: alternate.language,
        languageAlternates: decision.languageAlternates,
        slug: alternate.slug,
      });

      return createPublicLawCanonicalUrl(createCaseLawDecisionPath(params));
    },
  });

export const loadPublicCaseLawDecisionRoute = async ({
  params,
  queryClient,
  search,
}: PublicDecisionRouteLoaderOptions): Promise<PublicCaseLawDecision> => {
  const routeDecisionId = extractCaseLawDecisionIdFromIdRouteParam(params.slug);
  if (routeDecisionId) {
    const decision = await ensurePublicDecision(
      async () =>
        await ensureRouteQueryData(
          queryClient,
          decisionOptions(extractId(routeDecisionId)),
        ),
    );
    // A decision with a stored slug canonicalises to it; without one the
    // id form is canonical and no redirect happens.
    const canonicalParams = createCaseLawDecisionRouteParams({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    });

    const canonicalPath = createCaseLawDecisionPath(canonicalParams);
    const currentPath = createCaseLawDecisionPath(params);
    if (currentPath !== canonicalPath) {
      redirectToCanonicalDecisionPath({ canonicalParams, search });
    }

    primeDecisionProvisions(queryClient, decision.id);

    return decision;
  }

  const normalizedRouteLanguage = normalizeCaseLawLanguageSegment(
    params.language,
  );
  const decision = await ensurePublicDecision(
    async () =>
      await ensureRouteQueryData(
        queryClient,
        decisionBySlugOptions(
          params.language === undefined || normalizedRouteLanguage === null
            ? { slug: params.slug }
            : { language: normalizedRouteLanguage, slug: params.slug },
        ),
      ),
  );
  const canonicalParams = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

  const canonicalPath = createCaseLawDecisionPath(canonicalParams);
  const currentPath = createCaseLawDecisionPath(params);
  if (currentPath !== canonicalPath) {
    redirectToCanonicalDecisionPath({ canonicalParams, search });
  }

  primeDecisionProvisions(queryClient, decision.id);

  return decision;
};

export const createPublicCaseLawDecisionHead = ({
  decision,
  params,
}: PublicDecisionHeadOptions) => {
  const path = createCaseLawDecisionPath(params);
  const canonicalUrl = createPublicLawCanonicalUrl(path);

  return createPublicLawHead({
    alternateLinks: createDecisionAlternateLinks(decision),
    description: buildDescription(decision),
    jsonLd: createCaseLawDecisionJsonLd({
      canonicalUrl,
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionDate: decision.decisionDate,
      decisionType: decision.decisionType,
      ecli: decision.ecli,
      language: decision.language,
      sourceName: decision.source?.name ?? null,
      sourceUrl: decision.sourceUrl,
      updatedAt: decision.updatedAt,
    }),
    path,
    title: pageTitleLiteral(decision.caseNumber),
    type: "article",
  });
};
