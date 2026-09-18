import { lazy, Suspense } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Minimize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useRequireAccount } from "@/components/auth/use-require-account";
import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import {
  createCaseDecisionViewTab,
  isCaseDecisionGenericTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import Tooltip from "@/components/tooltip";
import { buildDecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useMountEffect } from "@/hooks/use-effect";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
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
  // The block the URL names. A results row that could not open beside the
  // list lands here instead, at the passage and on the words it matched.
  const initialAnchorId = useRouterState({
    select: ({ location }) =>
      location.hash === "" ? undefined : location.hash,
  });
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
      judges: decision.judges,
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
      // The same decision, read the same way: docking it must not silently
      // drop the passage and the words the reader arrived on.
      createCaseDecisionViewTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
        ...(initialAnchorId === undefined ? {} : { anchorId: initialAnchorId }),
        ...(initialSearchQuery === undefined
          ? {}
          : { searchQuery: initialSearchQuery }),
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
        <OpenOriginalButton
          className="hidden md:inline-flex"
          href={originalUrl}
        />
        <Tooltip
          content={
            willSwap ? t("inspector.swapViews") : t("inspector.moveToSide")
          }
          render={
            <Button
              aria-label={
                willSwap ? t("inspector.swapViews") : t("inspector.moveToSide")
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
                aiMode="gated"
                decision={decision}
                decisionId={decisionId}
                initialAnchorId={initialAnchorId}
                initialSearchQuery={initialSearchQuery}
              />
            </div>
          }
        >
          <AuthenticatedCaseLawWorkspace
            decision={decision}
            decisionId={decisionId}
            initialAnchorId={initialAnchorId}
            initialSearchQuery={initialSearchQuery}
            user={authStatus.user}
          />
        </Suspense>
      ) : (
        <GuestDecisionWorkspace
          decision={decision}
          decisionId={decisionId}
          initialAnchorId={initialAnchorId}
          initialSearchQuery={initialSearchQuery}
        />
      )}
    </main>
  );
}

const GuestDecisionWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
  initialSearchQuery,
}: {
  decision: PublicCaseLawDecision;
  decisionId: ReturnType<typeof extractId>;
  initialAnchorId?: string | undefined;
  initialSearchQuery?: string | undefined;
}) => {
  const { accountDialog, ensureAccount } = useRequireAccount();

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <DecisionWorkspace
        aiMode="gated"
        decision={decision}
        decisionId={decisionId}
        initialAnchorId={initialAnchorId}
        initialSearchQuery={initialSearchQuery}
        onRequestAnalysis={() => {
          ensureAccount("generateHeadnotes");
        }}
      />
      {accountDialog}
    </div>
  );
};

/**
 * The facts of the decision on screen live in the inspector, not above the
 * text. The tab opens with the page and then belongs to the decision, not to
 * the page: leaving takes the text away, and the tab keeps offering to bring
 * it back. It never takes the focus away from a decision the reader had open
 * on the side, so a swap lands on the decision, not on its facts.
 */
const DecisionDetailsTab = ({
  decision,
}: {
  decision: PublicCaseLawDecision;
}) => {
  useMountEffect(() => {
    const store = useInspectorTabsStore.getState();
    const activeTab = store.tabs.find((tab) => tab.id === store.activeId);
    const keepActive =
      activeTab !== undefined && isCaseDecisionGenericTab(activeTab)
        ? activeTab.id
        : null;
    store.openView(
      createCaseDecisionDetailsTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    );
    if (keepActive !== null) {
      store.setActive(keepActive);
    }
  });
  return null;
};
