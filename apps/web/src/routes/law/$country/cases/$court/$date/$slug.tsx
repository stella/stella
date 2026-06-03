import { lazy, Suspense, useState } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";

import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
  extractLegacyCaseLawDecisionIdFromRouteParam,
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

export const Route = createFileRoute("/law/$country/cases/$court/$date/$slug")({
  loader: async ({ context: { queryClient }, params }) => {
    const legacyDecisionId = extractLegacyCaseLawDecisionIdFromRouteParam(
      params.slug,
    );
    const decision = await ensureCriticalQueryData(
      queryClient,
      legacyDecisionId
        ? decisionOptions(extractId(legacyDecisionId))
        : decisionBySlugOptions(params.slug),
    );
    const canonicalParams = createCaseLawDecisionRouteParams({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionDate: decision.decisionDate,
      decisionId: decision.id,
      slug: decision.slug,
    });

    const canonicalPath = createCaseLawDecisionPath(canonicalParams);
    const currentPath = createCaseLawDecisionPath(params);
    if (currentPath !== canonicalPath) {
      throw redirect({
        to: "/law/$country/cases/$court/$date/$slug",
        params: canonicalParams,
        replace: true,
      });
    }

    return decision;
  },
  head: ({ loaderData, params }) => {
    if (!loaderData?.caseNumber) {
      return { meta: [] };
    }

    const path = createCaseLawDecisionPath({
      country: params.country,
      court: params.court,
      date: params.date,
      slug: params.slug,
    });
    const canonicalUrl = createPublicLawCanonicalUrl(path);

    return createPublicLawHead({
      description: buildDescription(loaderData),
      jsonLd: createCaseLawDecisionJsonLd({
        canonicalUrl,
        caseNumber: loaderData.caseNumber,
        country: loaderData.country,
        court: loaderData.court,
        decisionDate: loaderData.decisionDate,
        decisionType: loaderData.decisionType,
        ecli: loaderData.ecli,
        language: loaderData.language,
        sourceName: loaderData.source?.name ?? null,
        sourceUrl: loaderData.sourceUrl,
        updatedAt: loaderData.updatedAt,
      }),
      path,
      title: pageTitleLiteral(loaderData.caseNumber),
      type: "article",
    });
  },
  component: PublicDecisionViewer,
});

function PublicDecisionViewer() {
  const params = Route.useParams({
    select: ({ country, court, date, slug }) => ({
      country,
      court,
      date,
      slug,
    }),
  });
  const decision = Route.useLoaderData();
  const decisionId = extractId(decision.id);
  const authStatus = useClientAuthStatus();
  const [authRedirectTo, setAuthRedirectTo] = useState<string | null>(null);
  const requestAuth = (redirectTo: string) => {
    setAuthRedirectTo(redirectTo);
  };
  const publicPath = createCaseLawDecisionPath({
    country: params.country,
    court: params.court,
    date: params.date,
    slug: params.slug,
  });

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
