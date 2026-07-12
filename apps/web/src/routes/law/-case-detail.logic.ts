import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import * as v from "valibot";

import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { createCaseLawLanguageAlternateLinks } from "@/lib/case-law-language-alternates";
import {
  type CaseLawDecisionRouteParams,
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
  extractLegacyCaseLawDecisionIdFromRouteParam,
  normalizeCaseLawLanguageSegment,
} from "@/lib/case-law-route";
import { APIError } from "@/lib/errors/api";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createCaseLawDecisionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
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

export type PublicDecisionLanguageAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  id: string;
  language: string;
  slug: string | null;
};

export type PublicCaseLawDecision = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  decisionType: string | null;
  documentAst: unknown;
  ecli: string | null;
  fulltext: string | null;
  id: string;
  language: string;
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  metadata?: Record<string, unknown> | null;
  slug?: string | null;
  source: { name: string | null } | null;
  sourceUrl: string | null;
  updatedAt: Date | string | null;
};

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
  const legacyDecisionId = extractLegacyCaseLawDecisionIdFromRouteParam(
    params.slug,
  );
  if (legacyDecisionId) {
    const decision = await ensurePublicDecision(
      async () =>
        await ensureRouteQueryData(
          queryClient,
          decisionOptions(extractId(legacyDecisionId)),
        ),
    );
    const canonicalParams = createCaseLawDecisionRouteParams({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    });

    const canonicalPath = createCaseLawDecisionPath(canonicalParams);
    const currentPath = createCaseLawDecisionPath(params);
    if (currentPath !== canonicalPath) {
      redirectToCanonicalDecisionPath({ canonicalParams, search });
    }

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
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

  const canonicalPath = createCaseLawDecisionPath(canonicalParams);
  const currentPath = createCaseLawDecisionPath(params);
  if (currentPath !== canonicalPath) {
    redirectToCanonicalDecisionPath({ canonicalParams, search });
  }

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
