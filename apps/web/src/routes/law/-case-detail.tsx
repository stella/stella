import { lazy, Suspense, useRef, useState } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { decisionHasNoDocument } from "@stll/decision-reader/decision-body-state.logic";
import { Button } from "@stll/ui/button";
import { Minimize2Icon } from "@stll/ui/icons";

import { useRequireAccount } from "@/components/auth/use-require-account";
import type { DecisionReaderAIGate } from "@/components/authenticated-decision-tools";
import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import {
  CASE_DECISION_PLACEMENT,
  createCaseDecisionViewTab,
  isCaseDecisionGenericTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { INSPECTOR_PANE_INTENT } from "@/components/inspector/inspector-store-types";
import type { InspectorOwnerRouteId } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { registerMainDecisionReader } from "@/components/inspector/main-decision-reader";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import Tooltip from "@/components/tooltip";
import { DECISION_AI_MODE } from "@/features/case-law/components/case-viewer/decision-ai-mode";
import { DecisionAppealReviews } from "@/features/case-law/components/case-viewer/decision-appeal-reviews";
import { buildDecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useRecordOpenedLawDocument } from "@/features/law-search-history/law-search-history-query";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { createUuid } from "@/lib/uuid";
import {
  extractId,
  fileMayHoldOthersOf,
  type PublicCaseLawDecision,
} from "@/routes/law/-case-detail.logic";
import { PublicDecisionFileNote } from "@/routes/law/-components/public-decision-file-note";
import { PublicDecisionTextNotice } from "@/routes/law/-components/public-decision-text-notice";

const AuthenticatedDecisionTools = lazy(async () => {
  const module = await import("@/components/authenticated-decision-tools");
  return {
    default: module.AuthenticatedDecisionTools,
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
  useRecordOpenedLawDocument({
    kind: "decision",
    documentId: decision.id,
    courtId: decision.courtId,
    documentIdentity:
      decision.courtAbbreviation === null
        ? { kind: "unknown" }
        : {
            kind: "decision",
            courtAbbreviation: decision.courtAbbreviation,
            courtTier: decision.courtTier,
          },
    title: { identifier: decision.caseNumber, description: decision.court },
  });
  const decisionId = extractId(decision.id);
  // The block the URL names. A results row that could not open beside the
  // list lands here instead, at the passage and on the words it matched.
  const routeAnchorId = useRouterState({
    select: ({ location }) =>
      location.hash === "" ? undefined : location.hash,
  });
  const [citationLanding, setCitationLanding] = useState<{
    route: string;
    anchorId: string;
    sessionId: string;
  } | null>(null);
  const landingRoute = `${decision.id}#${routeAnchorId ?? ""}`;
  if (citationLanding !== null && citationLanding.route !== landingRoute) {
    setCitationLanding(null);
  }
  const initialAnchorId =
    citationLanding?.route === landingRoute
      ? citationLanding.anchorId
      : routeAnchorId;
  const landingSessionId =
    citationLanding?.route === landingRoute
      ? citationLanding.sessionId
      : undefined;
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
  const openMainPassage = useLatestCallback(
    ({ anchorId, searchQuery }: CaseDecisionViewPayload) => {
      if (searchQuery !== undefined) {
        find.openFindAtQuery(searchQuery);
      }
      if (anchorId === undefined) {
        return;
      }
      setCitationLanding({
        route: landingRoute,
        anchorId,
        sessionId: createUuid(),
      });
    },
  );
  useExternalSyncEffect(
    () =>
      registerMainDecisionReader({
        decisionId: decision.id,
        openPassage: openMainPassage,
      }),
    [decision.id, openMainPassage],
  );
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
    inspector.open({
      decisionPlacement: CASE_DECISION_PLACEMENT.side,
      // The same decision, read the same way: docking it must not silently
      // drop the passage and the words the reader arrived on.
      ...createCaseDecisionViewTab({
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
    });
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
      {decision.country === "CZE" && (
        <div className="px-4 py-2">
          <DecisionAppealReviews
            reviews={decision.appealReviews}
            country={decision.country}
          />
        </div>
      )}
      {!noDocument && <InspectorFindBar find={find} />}
      <div className="flex min-h-0 flex-1 overflow-hidden" ref={contentRef}>
        {noDocument && <PublicDecisionTextNotice sourceUrl={originalUrl} />}
        {!noDocument &&
          (authStatus.isAuthenticated ? (
            <MemberDecisionWorkspace
              decision={decision}
              decisionId={decisionId}
              initialAnchorId={initialAnchorId}
              landingSessionId={landingSessionId}
              user={authStatus.user}
            />
          ) : (
            <GuestDecisionWorkspace
              decision={decision}
              decisionId={decisionId}
              initialAnchorId={initialAnchorId}
              landingSessionId={landingSessionId}
            />
          ))}
      </div>
    </main>
  );
}

type DecisionReaderProps = {
  decision: PublicCaseLawDecision;
  decisionId: ReturnType<typeof extractId>;
  initialAnchorId?: string | undefined;
  landingSessionId?: string | undefined;
};

/**
 * A member's reader mounts once and stays mounted. The member chunk arrives
 * after the text and mounts beside it, never around it: a provider above the
 * reader that was not there on its first render would replace the reader,
 * and the member would lose their scroll position, focus and selection. The
 * chunk's arrival only hands the reader its AI gate, which turns the gated
 * offer into the member's AI on the same reader.
 */
const MemberDecisionWorkspace = ({
  user,
  ...reader
}: DecisionReaderProps & { user: AuthenticatedUser }) => {
  const [aiGate, setAIGate] = useState<DecisionReaderAIGate | null>(null);

  return (
    <AuthenticatedUserProvider user={user}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DecisionWorkspace
          {...reader}
          {...(aiGate === null
            ? { aiMode: DECISION_AI_MODE.gated }
            : {
                aiMode: DECISION_AI_MODE.enabled,
                ensureAIAvailable: aiGate.ensureAIAvailable,
              })}
        />
      </div>
      <Suspense fallback={null}>
        <AuthenticatedDecisionTools
          decisionId={reader.decisionId}
          ref={setAIGate}
        />
      </Suspense>
    </AuthenticatedUserProvider>
  );
};

const GuestDecisionWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
  landingSessionId,
}: DecisionReaderProps) => {
  const ensureAccount = useRequireAccount();

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <DecisionWorkspace
        aiMode="gated"
        decision={decision}
        decisionId={decisionId}
        initialAnchorId={initialAnchorId}
        landingSessionId={landingSessionId}
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
