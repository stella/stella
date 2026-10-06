import { lazy, Suspense, useRef } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Minimize2Icon } from "@stll/ui/icons";

import { useRequireAccount } from "@/components/auth/use-require-account";
import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import {
  createCaseDecisionViewTab,
  isCaseDecisionGenericTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { INSPECTOR_PANE_INTENT } from "@/components/inspector/inspector-store-types";
import type { InspectorOwnerRouteId } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import Tooltip from "@/components/tooltip";
import { decisionHasNoDocument } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import { buildDecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { recordLawOpen } from "@/lib/law-search-history";
import {
  extractId,
  fileMayHoldOthersOf,
  type PublicCaseLawDecision,
} from "@/routes/law/-case-detail.logic";
import { PublicDecisionFileNote } from "@/routes/law/-components/public-decision-file-note";
import { PublicDecisionTextNotice } from "@/routes/law/-components/public-decision-text-notice";

const AuthenticatedCaseLawWorkspace = lazy(async () => {
  const module = await import("@/components/authenticated-case-law-workspace");
  return {
    default: module.AuthenticatedCaseLawWorkspace,
  };
});

type PublicDecisionViewerProps = {
  decision: PublicCaseLawDecision;
  initialSearchQuery?: string | undefined;
  /** The decision route rendering the page, which owns its details tab. */
  routeId: InspectorOwnerRouteId;
};

export function PublicDecisionViewer({
  decision,
  initialSearchQuery,
  routeId,
}: PublicDecisionViewerProps) {
  const decisionId = extractId(decision.id);
  const openedPath = useRouterState({
    select: ({ location }) => location.pathname,
  });
  useExternalSyncEffect(() => {
    recordLawOpen({
      kind: "decision",
      id: decision.id,
      title: `${decision.caseNumber} · ${decision.court}`,
      path: openedPath,
    });
  }, [decision.id, decision.caseNumber, decision.court, openedPath]);
  // The block the URL names. A results row that could not open beside the
  // list lands here instead, at the passage and on the words it matched.
  const initialAnchorId = useRouterState({
    select: ({ location }) =>
      location.hash === "" ? undefined : location.hash,
  });
  // The reader arrived by a docket that found this decision alone in a case
  // file whose other decisions the read may not have reached.
  const fileMayHoldOthers = useRouterState({
    select: ({ location }) => fileMayHoldOthersOf(location.search),
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

  const noDocument = decisionHasNoDocument(decision);
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const find = useInspectorFind({
    contentRef,
    enabled: !noDocument,
    highlightKey: `decision-page-${decision.id}`,
    initialQuery: initialSearchQuery,
    panelRef,
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
        ...(find.findQuery === "" ? {} : { searchQuery: find.findQuery }),
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
    <main
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      ref={panelRef}
    >
      <DecisionDetailsTab
        decision={decision}
        key={decision.id}
        routeId={routeId}
      />
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
      {fileMayHoldOthers && <PublicDecisionFileNote />}
      {!noDocument && <InspectorFindBar find={find} />}
      <div className="flex min-h-0 flex-1 overflow-hidden" ref={contentRef}>
        {noDocument && <PublicDecisionTextNotice sourceUrl={originalUrl} />}
        {!noDocument &&
          (authStatus.isAuthenticated ? (
            <Suspense
              fallback={
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <DecisionWorkspace
                    aiMode="gated"
                    decision={decision}
                    decisionId={decisionId}
                    initialAnchorId={initialAnchorId}
                  />
                </div>
              }
            >
              <AuthenticatedCaseLawWorkspace
                decision={decision}
                decisionId={decisionId}
                initialAnchorId={initialAnchorId}
                user={authStatus.user}
              />
            </Suspense>
          ) : (
            <GuestDecisionWorkspace
              decision={decision}
              decisionId={decisionId}
              initialAnchorId={initialAnchorId}
            />
          ))}
      </div>
    </main>
  );
}

const GuestDecisionWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
}: {
  decision: PublicCaseLawDecision;
  decisionId: ReturnType<typeof extractId>;
  initialAnchorId?: string | undefined;
}) => {
  const ensureAccount = useRequireAccount();

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <DecisionWorkspace
        aiMode="gated"
        decision={decision}
        decisionId={decisionId}
        initialAnchorId={initialAnchorId}
        onRequestAnalysis={() => {
          ensureAccount();
        }}
      />
    </div>
  );
};

/**
 * The facts of the decision on screen live in the inspector, not above the
 * text. The tab belongs to the page: the facts of a decision whose text is
 * gone describe nothing, so leaving closes it and a reload elsewhere does not
 * restore it. Unmount closes it too: the next decision on the same route is
 * a new page. A details tab the reader opened before arriving is theirs and
 * stays. The seed never takes the focus away from a decision the reader had
 * open on the side, so a swap lands on the decision, not on its facts.
 *
 * It also owns the pane state for the whole decision mount: this effect runs
 * before the chat tab's, and both seed with `pane: "keep"`, so the pane is
 * decided once here and never twice.
 */
const DecisionDetailsTab = ({
  decision,
  routeId,
}: {
  decision: PublicCaseLawDecision;
  routeId: InspectorOwnerRouteId;
}) => {
  useMountEffect(() => {
    const store = useInspectorTabsStore.getState();
    const activeTab = store.tabs.find((tab) => tab.id === store.activeId);
    const keepActive =
      activeTab !== undefined && isCaseDecisionGenericTab(activeTab)
        ? activeTab.id
        : null;
    // An inspector that held nothing before the seed belongs to a reader who
    // did not open it: the decision's tabs land on the rail collapsed. Any
    // other inspector already carries the reader's own expand or collapse,
    // which persists across pages, so the seed leaves it alone.
    const seedsIntoEmptyInspector = store.tabs.length === 0;
    const tab = createCaseDecisionDetailsTab({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    });
    const openedByReader = store.tabs.some(({ id }) => id === tab.id);
    store.openView({
      ...tab,
      ...(openedByReader ? {} : { ownerRouteId: routeId }),
      pane: INSPECTOR_PANE_INTENT.keep,
    });
    if (keepActive !== null) {
      store.setActive(keepActive);
    }
    if (seedsIntoEmptyInspector) {
      store.setMinimized(true);
    }
    return () => {
      const seeded = useInspectorTabsStore
        .getState()
        .tabs.find(({ id }) => id === tab.id);
      if (seeded?.type === "view" && seeded.ownerRouteId === routeId) {
        useInspectorTabsStore.getState().closeTab(tab.id);
      }
    };
  });
  return null;
};
