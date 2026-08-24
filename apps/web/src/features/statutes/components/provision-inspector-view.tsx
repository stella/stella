import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import {
  CitingDecisionItem,
  ProvisionCitingDecisions,
} from "@/features/statutes/components/provision-citing-decisions";
import type { CitingDecisionRow } from "@/features/statutes/components/provision-citing-decisions";
import { ProvisionHistory } from "@/features/statutes/components/provision-history";
import { ProvisionWording } from "@/features/statutes/components/provision-wording";
import { StatuteVersionSwitcher } from "@/features/statutes/components/statute-version-switcher";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { topCitingDecisionsOptions } from "@/features/statutes/queries/citing-decisions";
import { statuteVersionsOptions } from "@/features/statutes/queries/statutes";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toStatuteCountrySegment } from "@/lib/statute-route";

// The ask actions pull the chat composer's draft machinery; a visitor who
// cannot chat never loads it.
const LazyProvisionAskActions = lazy(async () => {
  const module =
    await import("@/features/statutes/components/provision-ask-actions");
  return { default: module.ProvisionAskActions };
});

/**
 * One provision of a statute, in the inspector: its wording first, landed on
 * the cited subdivision; the decisions that carry the most authority on it,
 * with the passages applying it; every citing decision; how the wording
 * changed; and a way to ask about it that starts from those passages.
 */
export const ProvisionInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<ProvisionViewPayload>) => {
  const t = useTranslations();
  const { payload } = tab;
  const updateView = useInspectorTabsStore((state) => state.updateView);
  const { data: versions } = useQuery(
    statuteVersionsOptions(payload.documentId),
  );
  // The tab keeps its identity across versions: the reader is still looking
  // at the same provision, in another consolidation's wording.
  const switchVersion = (documentId: string) => {
    const next = optionalArray(versions).find(
      (version) => version.id === documentId,
    );
    if (next === undefined) {
      return;
    }
    const nextPayload: ProvisionViewPayload = {
      ...payload,
      documentId: next.id,
      versionCount: optionalArray(versions).length,
      versionValidFrom: next.versionValidFrom,
    };
    updateView({ id: tab.id, label: tab.label, payload: nextPayload });
  };
  const { data: leading } = useQuery(
    topCitingDecisionsOptions({
      anchor: payload.anchorId,
      eli: payload.eli,
      jurisdiction: payload.jurisdiction,
    }),
  );
  const leadingDecisions =
    leading === undefined ? [] : uniqueByDecision(leading);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={tab.label} onClose={onClose} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 p-4">
          {/* The tab header already names the provision and the act; this
              row only offers the consolidation to read and the way out. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatuteVersionSwitcher
              currentVersionId={payload.documentId}
              onVersionChange={switchVersion}
              versions={optionalArray(versions)}
            />
            <Link
              className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
              hash={payload.highlightAnchorId ?? payload.anchorId}
              params={{
                country: toStatuteCountrySegment(payload.jurisdiction),
                documentId: payload.documentId,
              }}
              to="/law/$country/statutes/$documentId"
            >
              {t("statutes.showInText")}
            </Link>
          </div>

          <ProvisionWording
            anchorId={payload.anchorId}
            documentId={payload.documentId}
            highlightAnchorId={payload.highlightAnchorId}
          />

          {leadingDecisions.length > 0 && (
            <ProvisionSection title={t("statutes.leadingDecisions")}>
              <ul className="m-0 flex list-none flex-col p-0">
                {leadingDecisions.map((decision) => (
                  <li key={decision.decisionId}>
                    <CitingDecisionItem decision={decision} />
                  </li>
                ))}
              </ul>
            </ProvisionSection>
          )}

          <ProvisionSection title={t("caseLaw.viewer.citedBy")}>
            <ProvisionCitingDecisions
              anchorId={payload.anchorId}
              eli={payload.eli}
              jurisdiction={payload.jurisdiction}
            />
          </ProvisionSection>

          {payload.versionCount > 1 && (
            <ProvisionSection title={t("common.history")}>
              <ProvisionHistory
                anchorId={payload.anchorId}
                documentId={payload.documentId}
              />
            </ProvisionSection>
          )}

          <ProvisionSection title={t("common.askAI")}>
            <ProvisionAsk passages={leadingDecisions} payload={payload} />
          </ProvisionSection>
        </div>
      </ScrollArea>
    </div>
  );
};

/** One entry per decision: a decision applying the provision twice leads once. */
const uniqueByDecision = (
  rows: readonly CitingDecisionRow[],
): CitingDecisionRow[] => {
  const seen = new Set<string>();
  const unique: CitingDecisionRow[] = [];
  for (const row of rows) {
    if (seen.has(row.decisionId)) {
      continue;
    }
    seen.add(row.decisionId);
    unique.push(row);
  }
  return unique;
};

const ProvisionSection = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {title}
    </h3>
    {children}
  </section>
);

/**
 * Asking needs a session: the chat is an account feature. A visitor is
 * offered the sign-in instead, and keeps the wording, citations and history.
 */
const ProvisionAsk = ({
  passages,
  payload,
}: {
  passages: readonly CitingDecisionRow[];
  payload: ProvisionViewPayload;
}) => {
  const t = useTranslations();
  const user = useMaybeAuthenticatedUser();
  const requestSignIn = usePublicSignInRequest();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  if (user !== null) {
    return (
      <Suspense fallback={<Skeleton className="h-16 w-full" />}>
        <LazyProvisionAskActions passages={passages} payload={payload} />
      </Suspense>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionAskSignIn")}
      </p>
      {requestSignIn === null ? (
        <Button
          className="text-xs"
          render={<Link search={{ redirectTo: currentHref }} to="/auth" />}
          size="sm"
          variant="outline"
        >
          {t("auth.signIn")}
        </Button>
      ) : (
        <Button
          className="text-xs"
          onClick={() => requestSignIn(currentHref)}
          size="sm"
          variant="outline"
        >
          {t("auth.signIn")}
        </Button>
      )}
    </div>
  );
};
