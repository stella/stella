import { lazy, Suspense } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ExternalLinkIcon, Minimize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import {
  createCaseDecisionViewTab,
  isCaseDecisionGenericTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import Tooltip from "@/components/tooltip";
import { buildDecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useMountEffect } from "@/hooks/use-effect";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";
import {
  extractId,
  type PublicCaseLawDecision,
} from "@/routes/law/-case-detail.logic";

const AuthenticatedCaseLawWorkspace = lazy(async () => {
  const module = await import("@/components/authenticated-case-law-workspace");
  return {
    default: module.AuthenticatedCaseLawWorkspace,
  };
});

type PublicDecisionViewerProps = {
  decision: PublicCaseLawDecision;
  initialSearchQuery?: string | undefined;
};

export function PublicDecisionViewer({
  decision,
  initialSearchQuery,
}: PublicDecisionViewerProps) {
  const decisionId = extractId(decision.id);
  const authStatus = useClientAuthStatus();
  const inspector = useInspectorView();
  const navigate = useNavigate();
  const t = useTranslations();

  // When the inspector's active tab is another decision, the two swap
  // places: this one moves to the side and the side one takes over the
  // main view. Otherwise the main view falls back to the case list.
  const willSwap = useInspectorTabsStore((s) => {
    const activeTab = s.tabs.find((tab) => tab.id === s.activeId);
    return (
      activeTab !== undefined &&
      isCaseDecisionGenericTab(activeTab) &&
      activeTab.payload.decisionId !== decision.id
    );
  });

  const originalUrl =
    buildDecisionFacts({
      decisionType: decision.decisionType,
      metadata: decision.metadata,
      source: decision.source,
      sourceUrl: decision.sourceUrl,
    }).source?.url ?? null;

  const moveToSide = () => {
    const { activeId, tabs } = useInspectorTabsStore.getState();
    const activeTab = tabs.find((tab) => tab.id === activeId);
    const swapTarget =
      activeTab !== undefined &&
      isCaseDecisionGenericTab(activeTab) &&
      activeTab.payload.decisionId !== decision.id
        ? activeTab
        : undefined;
    if (swapTarget !== undefined) {
      inspector.close(swapTarget.id);
    }
    inspector.open(
      createCaseDecisionViewTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    );
    if (swapTarget !== undefined) {
      detached(
        navigateToCaseDecisionMain(navigate, swapTarget.payload),
        "case-law.swap-with-side",
      );
      return;
    }
    detached(
      navigate({
        to: "/law/cases",
        search: { country: decision.country.toLowerCase() },
      }),
      "case-law.move-to-side",
    );
  };

  return (
    <main className="flex min-h-0 flex-1 overflow-hidden">
      <DecisionDetailsTab decision={decision} key={decision.id} />
      <ChromeHeaderActions>
        {originalUrl !== null && (
          <Tooltip
            content={t("inspector.external.openOriginal")}
            render={
              <Button
                className="hidden md:inline-flex"
                render={
                  <a
                    href={sanitizeHref(originalUrl)}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <ExternalLinkIcon aria-hidden="true" className="size-4" />
                    <span className="sr-only">
                      {t("inspector.external.openOriginal")}
                    </span>
                  </a>
                }
                size="icon-sm"
                variant="ghost"
              />
            }
          />
        )}
        <Tooltip
          content={willSwap ? t("inspector.swapViews") : t("chat.moveToSide")}
          render={
            <Button
              aria-label={
                willSwap ? t("inspector.swapViews") : t("chat.moveToSide")
              }
              className="hidden md:inline-flex"
              onClick={moveToSide}
              size="icon-sm"
              variant="ghost"
            >
              <Minimize2Icon className="size-4" />
            </Button>
          }
        />
      </ChromeHeaderActions>
      {authStatus.isAuthenticated ? (
        <Suspense
          fallback={
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <DecisionWorkspace
                aiMode="locked"
                decision={decision}
                decisionId={decisionId}
                initialSearchQuery={initialSearchQuery}
              />
            </div>
          }
        >
          <AuthenticatedCaseLawWorkspace
            decision={decision}
            decisionId={decisionId}
            initialSearchQuery={initialSearchQuery}
            user={authStatus.user}
          />
        </Suspense>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <DecisionWorkspace
            aiMode="locked"
            decision={decision}
            decisionId={decisionId}
            initialSearchQuery={initialSearchQuery}
          />
        </div>
      )}
    </main>
  );
}

/**
 * The facts of the decision on screen live in the inspector, not above the
 * text. The tab opens with the page and leaves with it; it never takes the
 * focus away from a decision the reader had open on the side, so a swap
 * lands on the decision, not on its facts.
 */
const DecisionDetailsTab = ({
  decision,
}: {
  decision: PublicCaseLawDecision;
}) => {
  const routeId = useRouterState({
    select: (state) => state.matches.at(-1)?.routeId ?? "/law",
  });
  useMountEffect(() => {
    const store = useInspectorTabsStore.getState();
    const activeTab = store.tabs.find((tab) => tab.id === store.activeId);
    const keepActive =
      activeTab !== undefined && isCaseDecisionGenericTab(activeTab)
        ? activeTab.id
        : null;
    const tab = createCaseDecisionDetailsTab(
      {
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      },
      routeId,
    );
    store.openView(tab);
    if (keepActive !== null) {
      store.setActive(keepActive);
    }
    return () => {
      useInspectorTabsStore.getState().closeTab(tab.id);
    };
  });
  return null;
};
