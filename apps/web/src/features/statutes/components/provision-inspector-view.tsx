import { lazy, Suspense, useRef } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { useRequireAccount } from "@/components/auth/use-require-account";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import { useReaderTextScale } from "@/components/legal-reader/use-reader-text-scale";
import {
  CitingDecisionItem,
  ProvisionCitingDecisions,
} from "@/features/statutes/components/provision-citing-decisions";
import type { CitingDecisionRow } from "@/features/statutes/components/provision-citing-decisions";
import { ProvisionHistory } from "@/features/statutes/components/provision-history";
import { ProvisionWording } from "@/features/statutes/components/provision-wording";
import { StatuteValidityIndicator } from "@/features/statutes/components/statute-validity-indicator";
import { StatuteVersionSwitcher } from "@/features/statutes/components/statute-version-switcher";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { topCitingDecisionsOptions } from "@/features/statutes/queries/citing-decisions";
import {
  statuteOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import { optionalArray } from "@/lib/arrays";
import { createStatuteLinkTarget } from "@/lib/statute-route";

// The ask actions pull the prompt builders the chat needs; the pane is read
// far more often than it is asked a question, so they arrive on demand.
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
  const textScale = useReaderTextScale();
  const updateView = useInspectorTabsStore((state) => state.updateView);
  const { data: versions } = useQuery(
    statuteVersionsOptions(payload.documentId),
  );
  const availableVersions = optionalArray(versions);
  // The opener's seed stands only until the list arrives: an opener with no
  // reason to read the work's versions carries one.
  const versionCount =
    versions === undefined ? payload.versionCount : availableVersions.length;
  const selectedVersion = availableVersions.find(
    (version) => version.id === payload.documentId,
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The wording's own query, read here only for whether there is text to
  // search yet; the fetch is the one `ProvisionWording` already makes.
  const { isSuccess: wordingReady } = useQuery(
    statuteOptions(payload.documentId),
  );
  // Cmd/Ctrl+F belongs to the provision in front of the reader rather than to
  // the results table behind it.
  const find = useInspectorFind({
    contentRef,
    enabled: wordingReady,
    highlightKey: tab.id,
    panelRef,
  });
  // The chat is bound to the consolidation the provision belongs to: the send
  // endpoint selects provisions from the act, and the tab's own payload names
  // both. The act is the same document the full reader binds, so a question
  // asked here and one asked there are one conversation.
  const activeLegal = {
    type: "statute",
    documentId: payload.documentId,
    title: payload.statuteTitle,
  } as const satisfies ActiveLegalDocument;

  return (
    <div
      className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden"
      ref={panelRef}
    >
      <InspectorTabHeader label={tab.label} onClose={onClose} />
      <InspectorFindBar find={find} />
      {/* The bar floats over the provision the way it floats over a PDF page;
          the scroll area below it moves, the corner does not. */}
      <LegalReaderAIChat activeLegal={activeLegal} className="min-h-0 flex-1">
        <ScrollArea axis="vertical" className="h-full">
          {/* The gutter and the trailing room the composer needs belong to the
              column; the text root inside it carries the reader's own scale. */}
          <div data-slot="reader-document-column">
            {/* The floating bar owns the top corner, so the first row starts
                below it rather than under the zoom controls. */}
            <div
              className="flex flex-col gap-6 pt-12 pb-4"
              ref={contentRef}
              {...textScale.rootProps}
            >
              {selectedVersion !== undefined && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StatuteValidityIndicator
                    status={selectedVersion.status}
                    validFrom={selectedVersion.versionValidFrom}
                    validTo={selectedVersion.versionValidTo}
                  />
                  <OpenOriginalButton
                    href={
                      selectedVersion.documentUrl ?? selectedVersion.sourceUrl
                    }
                  />
                </div>
              )}

              {/* The tab header already names the provision and the act; this
              row offers the consolidation to read and the way out. */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatuteVersionSwitcher
                  currentVersionId={payload.documentId}
                  onVersionChange={switchVersion}
                  versions={availableVersions}
                />
                <Link
                  className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                  hash={payload.highlightAnchorId ?? payload.anchorId}
                  {...createStatuteLinkTarget({
                    country: selectedVersion?.country ?? payload.jurisdiction,
                    documentId: payload.documentId,
                    eli: selectedVersion?.eli ?? null,
                    slug: selectedVersion?.slug ?? null,
                    versionValidFrom: selectedVersion?.versionValidFrom ?? null,
                  })}
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

              {versionCount > 1 && (
                <ProvisionSection title={t("common.history")}>
                  <ProvisionHistory
                    anchorId={payload.anchorId}
                    documentId={payload.documentId}
                  />
                </ProvisionSection>
              )}

              <ProvisionSection title={t("common.askAI")}>
                <ProvisionAsk
                  activeLegal={activeLegal}
                  passages={leadingDecisions}
                  payload={payload}
                />
              </ProvisionSection>
            </div>
          </div>
        </ScrollArea>
        <ViewerOverlayBar>
          <ZoomControls
            atMax={textScale.atMax}
            atMin={textScale.atMin}
            level={textScale.level}
            onReset={textScale.reset}
            onZoom={textScale.zoom}
          />
        </ViewerOverlayBar>
      </LegalReaderAIChat>
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
 * The two ways to ask about a provision, drawn for every reader. Writing the
 * question costs nothing; sending it is what needs an account, and the gate
 * asks there, keeping the wording, the citations and the history on screen.
 */
const ProvisionAsk = ({
  activeLegal,
  passages,
  payload,
}: {
  activeLegal: ActiveLegalDocument;
  passages: readonly CitingDecisionRow[];
  payload: ProvisionViewPayload;
}) => {
  const ensureAccount = useRequireAccount();

  return (
    <Suspense fallback={<Skeleton className="h-16 w-full" />}>
      <LazyProvisionAskActions
        activeLegal={activeLegal}
        ensureAccount={ensureAccount}
        passages={passages}
        payload={payload}
      />
    </Suspense>
  );
};
