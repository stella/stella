import { lazy, Suspense, useState } from "react";

import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import {
  type CaseLawDecisionRouteParams,
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
  extractLegacyCaseLawDecisionIdFromRouteParam,
  normalizeCaseLawLanguageSegment,
} from "@/lib/case-law-route";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createCaseLawDecisionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureCriticalQueryData } from "@/lib/react-query";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

const AuthenticatedCaseLawWorkspace = lazy(async () => {
  const module = await import("@/components/authenticated-case-law-workspace");
  return {
    default: module.AuthenticatedCaseLawWorkspace,
  };
});

const SignInDialog = lazy(async () => {
  const module = await import("@/components/auth/sign-in-dialog");
  return { default: module.SignInDialog };
});

type PublicDecisionRouteParams = CaseLawDecisionRouteParams;

type PublicDecisionRouteLoaderOptions = {
  params: PublicDecisionRouteParams;
  queryClient: QueryClient;
};

type PublicDecisionHeadOptions = {
  decision: PublicCaseLawDecision;
  params: PublicDecisionRouteParams;
};

type PublicDecisionViewerProps = {
  decision: PublicCaseLawDecision;
  params: PublicDecisionRouteParams;
};

type PublicDecisionLanguageAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  id: string;
  language: string;
  slug: string | null;
};

type PublicCaseLawDecision = {
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

const extractId = (param: string): SafeId<"caseLawDecision"> =>
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

const redirectToCanonicalDecisionPath = (
  canonicalParams: CaseLawDecisionRouteParams,
) => {
  if (canonicalParams.language) {
    throw redirect({
      to: "/law/$country/cases/$court/$date/$language/$slug",
      params: {
        country: canonicalParams.country,
        court: canonicalParams.court,
        date: canonicalParams.date,
        language: canonicalParams.language,
        slug: canonicalParams.slug,
      },
      replace: true,
    });
  }

  throw redirect({
    to: "/law/$country/cases/$court/$date/$slug",
    params: {
      country: canonicalParams.country,
      court: canonicalParams.court,
      date: canonicalParams.date,
      slug: canonicalParams.slug,
    },
    replace: true,
  });
};

const createDecisionAlternateLinks = (
  decision: PublicCaseLawDecision,
): PublicLawAlternateLink[] => {
  if (decision.languageAlternates.length <= 1) {
    return [];
  }

  const alternateLinks: PublicLawAlternateLink[] = [];
  for (const alternate of decision.languageAlternates) {
    const hreflang = normalizeCaseLawLanguageSegment(alternate.language);
    if (hreflang === null) {
      continue;
    }

    const params = createCaseLawDecisionRouteParams({
      caseNumber: alternate.caseNumber,
      country: alternate.country,
      court: alternate.court,
      decisionDate: alternate.decisionDate,
      decisionId: alternate.id,
      language: alternate.language,
      languageAlternates: decision.languageAlternates,
      slug: alternate.slug,
    });

    alternateLinks.push({
      hreflang,
      href: createPublicLawCanonicalUrl(createCaseLawDecisionPath(params)),
    });
  }

  const defaultAlternate =
    decision.languageAlternates.find(
      (alternate) =>
        normalizeCaseLawLanguageSegment(alternate.language) === "en",
    ) ?? decision.languageAlternates.at(0);
  if (!defaultAlternate) {
    return alternateLinks;
  }

  const defaultParams = createCaseLawDecisionRouteParams({
    caseNumber: defaultAlternate.caseNumber,
    country: defaultAlternate.country,
    court: defaultAlternate.court,
    decisionDate: defaultAlternate.decisionDate,
    decisionId: defaultAlternate.id,
    language: defaultAlternate.language,
    languageAlternates: decision.languageAlternates,
    slug: defaultAlternate.slug,
  });

  alternateLinks.push({
    hreflang: "x-default",
    href: createPublicLawCanonicalUrl(createCaseLawDecisionPath(defaultParams)),
  });

  return alternateLinks;
};

export const loadPublicCaseLawDecisionRoute = async ({
  params,
  queryClient,
}: PublicDecisionRouteLoaderOptions): Promise<PublicCaseLawDecision> => {
  const legacyDecisionId = extractLegacyCaseLawDecisionIdFromRouteParam(
    params.slug,
  );
  if (legacyDecisionId) {
    const decision = await ensureCriticalQueryData(
      queryClient,
      decisionOptions(extractId(legacyDecisionId)),
    );
    const canonicalParams = createCaseLawDecisionRouteParams({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionDate: decision.decisionDate,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    });

    const canonicalPath = createCaseLawDecisionPath(canonicalParams);
    const currentPath = createCaseLawDecisionPath(params);
    if (currentPath !== canonicalPath) {
      redirectToCanonicalDecisionPath(canonicalParams);
    }

    return decision;
  }

  const decision = await ensureCriticalQueryData(
    queryClient,
    decisionBySlugOptions(
      params.language === undefined
        ? { slug: params.slug }
        : { language: params.language, slug: params.slug },
    ),
  );
  const canonicalParams = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

  const canonicalPath = createCaseLawDecisionPath(canonicalParams);
  const currentPath = createCaseLawDecisionPath(params);
  if (currentPath !== canonicalPath) {
    redirectToCanonicalDecisionPath(canonicalParams);
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

export function PublicDecisionViewer({
  decision,
  params,
}: PublicDecisionViewerProps) {
  const decisionId = extractId(decision.id);
  const authStatus = useClientAuthStatus();
  const [authRedirectTo, setAuthRedirectTo] = useState<string | null>(null);
  const requestAuth = (redirectTo: string) => {
    setAuthRedirectTo(redirectTo);
  };
  const publicPath = createCaseLawDecisionPath(params);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {authStatus.isAuthenticated ? (
        <Suspense
          fallback={
            <DecisionWorkspace
              aiMode="locked"
              decision={decision}
              decisionId={decisionId}
              publicPath={publicPath}
              requestAuth={requestAuth}
            />
          }
        >
          <AuthenticatedCaseLawWorkspace
            decision={decision}
            decisionId={decisionId}
            user={authStatus.user}
          />
        </Suspense>
      ) : (
        <DecisionWorkspace
          aiMode="locked"
          decision={decision}
          decisionId={decisionId}
          publicPath={publicPath}
          requestAuth={requestAuth}
        />
      )}
      {authRedirectTo !== null && (
        <Suspense fallback={null}>
          <SignInDialog
            onOpenChange={(open) => {
              if (!open) {
                setAuthRedirectTo(null);
              }
            }}
            open
            redirectTo={authRedirectTo}
          />
        </Suspense>
      )}
    </main>
  );
}
