import { useRef } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { pickVersionAt } from "@stll/api-contract/statute-version";
import type { AISuggestionPreset } from "@stll/folio-react";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Maximize2Icon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { VIEWER_OVERLAY_BAR_TOP_CLEARANCE } from "@/components/inspector/viewer-overlay-bar";
import { FloatingZoomControls } from "@/components/inspector/zoom-controls";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import { useWebReaderTextScale as useReaderTextScale } from "@/components/legal-reader/use-web-reader-text-scale";
import Tooltip from "@/components/tooltip";
import type { CitingDecisionRow } from "@/features/statutes/components/provision-citing-decisions";
import { ProvisionCitingDecisions } from "@/features/statutes/components/provision-citing-decisions";
import { ProvisionHistory } from "@/features/statutes/components/provision-history";
import { ProvisionVersionContext } from "@/features/statutes/components/provision-version-context";
import { ProvisionWording } from "@/features/statutes/components/provision-wording";
import { StatuteDisplayLabel } from "@/features/statutes/components/statute-display-label";
import { StatuteStatusDot } from "@/features/statutes/components/statute-validity-indicator";
import { StatuteVersionMenu } from "@/features/statutes/components/statute-version-menu";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import {
  statuteCitationCountsOptions,
  topCitingDecisionsOptions,
} from "@/features/statutes/queries/citing-decisions";
import type { PublicStatuteVersion } from "@/features/statutes/queries/statutes";
import {
  statuteOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import {
  readProvisionCitingSearch,
  updateProvisionCitingSearch,
} from "@/features/statutes/statute-page-search";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { AVAILABLE_EVERYWHERE } from "@/lib/platform/requirements.logic";
import { queryView } from "@/lib/query-view.logic";
import {
  formatValidityDate,
  formatValidityRange,
} from "@/lib/statutes/statute-format";
import { createStatuteLinkTarget } from "@/lib/statutes/statute-route";
import { useQueryViewError } from "@/lib/use-query-view";

const SUMMARIZE_PRESET_ID = "provision-summarize-case-law";

/**
 * One provision of a statute, in the inspector: its wording first, landed on
 * the cited subdivision; every decision citing it, the leading ones first;
 * and the wordings it has had. Questions go to the chat docked at the foot of
 * the pane, which offers a start from the leading decisions' passages.
 */
export const ProvisionInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<ProvisionViewPayload>) => {
  const t = useTranslations();
  const { payload } = tab;
  const navigate = useNavigate();
  const search = useRouterState({ select: (state) => state.location.search });
  const citingFilters = readProvisionCitingSearch(search);
  const countsView = queryView(
    useQuery(
      statuteCitationCountsOptions({
        eli: payload.eli,
        jurisdiction: payload.jurisdiction,
      }),
    ),
  );
  const citingCount =
    countsView.type === "items" && countsView.items.status === "ready"
      ? (countsView.items.provisions.find(
          (row) => row.anchor === payload.anchorId,
        )?.decisionCount ?? 0)
      : null;
  const textScale = useReaderTextScale("provision");
  const updateView = useInspectorTabsStore((state) => state.updateView);
  const versionsQuery = useQuery(statuteVersionsOptions(payload.documentId));
  const versionsView = queryView(versionsQuery);
  useQueryViewError(versionsView, "ProvisionInspectorView:query");
  const versions =
    versionsView.type === "items" ? versionsView.items : undefined;
  const availableVersions = optionalArray(versions);
  // The opener's seed stands only until the list arrives: an opener with no
  // reason to read the work's versions carries one.
  const versionCount =
    versions === undefined ? payload.versionCount : availableVersions.length;
  const today = Temporal.Now.plainDateISO(Temporal.Now.timeZoneId()).toString();
  const currentVersion = pickVersionAt(
    availableVersions.filter(
      (version) =>
        resolveStatuteDisplayStatus({
          status: version.status,
          validFrom: version.versionValidFrom,
          today,
        }) === "current",
    ),
    today,
  );
  const selectedVersion = availableVersions.find(
    (version) => version.id === payload.documentId,
  );
  // The tab keeps its identity across versions: the reader is still looking
  // at the same provision, in another consolidation's wording.
  const switchVersion = (documentId: string) => {
    const next = availableVersions.find((version) => version.id === documentId);
    if (next === undefined) {
      return;
    }
    const nextPayload: ProvisionViewPayload = {
      ...payload,
      documentId: next.id,
      versionCount: availableVersions.length,
      versionValidFrom: next.versionValidFrom,
    };
    updateView({ id: tab.id, label: tab.label, payload: nextPayload });
  };
  // The act's page at this consolidation, where the reader's own text and its
  // comparison live.
  const statuteTarget = createStatuteLinkTarget({
    country: selectedVersion?.country ?? payload.jurisdiction,
    documentId: payload.documentId,
    eli: selectedVersion?.eli ?? null,
    slug: selectedVersion?.slug ?? null,
    versionValidFrom: selectedVersion?.versionValidFrom ?? null,
  });
  // Comparing sets this provision's wording in another version beside the
  // one on screen, in the comparison the act's page already draws.
  const openComparison = (versionValidFrom: string) => {
    detached(
      navigate({
        ...statuteTarget,
        search: { compare: versionValidFrom, provision: payload.anchorId },
      }),
      "statutes.provision-compare",
    );
  };
  // The citing list shows this read's failure and its retry; here it only
  // seeds the chat's start, which goes without passages until it lands.
  const leadingView = queryView(
    useQuery(
      topCitingDecisionsOptions({
        anchor: payload.anchorId,
        eli: payload.eli,
        jurisdiction: payload.jurisdiction,
      }),
    ),
  );
  const leadingDecisions =
    leadingView.type === "items" ? leadingView.items : [];
  const summarizePreset = useProvisionSummaryPreset({
    passages: leadingDecisions,
    payload,
  });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The wording's own query, read here only for whether there is text to
  // search yet; the fetch is the one `ProvisionWording` already makes.
  const { data: statute, isSuccess: wordingReady } = useQuery(
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
  // Opened from a decision that applied this very consolidation, the pane
  // says so: the version is the decision's, not merely the one picked.
  const appliedInDecision =
    payload.decisionContext !== undefined &&
    payload.decisionContext.appliedDocumentId === payload.documentId;

  return (
    <div
      className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden"
      ref={panelRef}
    >
      <InspectorTabHeader
        actions={[
          ...(selectedVersion === undefined
            ? []
            : [
                {
                  id: "open-original",
                  requires: AVAILABLE_EVERYWHERE,
                  render: () => (
                    <OpenOriginalButton
                      href={
                        selectedVersion.documentUrl ?? selectedVersion.sourceUrl
                      }
                      size="icon-xs"
                    />
                  ),
                },
              ]),
          {
            id: "show-in-text",
            requires: AVAILABLE_EVERYWHERE,
            render: () => (
              <Tooltip
                content={t("statutes.showInText")}
                render={
                  <Button
                    aria-label={t("statutes.showInText")}
                    render={
                      <Link
                        hash={payload.highlightAnchorId ?? payload.anchorId}
                        {...statuteTarget}
                      />
                    }
                    size="icon-xs"
                    variant="ghost"
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </Tooltip>
            ),
          },
        ]}
        label={tab.label}
        labelOverflow="wrap"
        labelContent={
          statute === undefined ? undefined : (
            <>
              <span className="block">{payload.provisionLabel}</span>
              <StatuteDisplayLabel statute={statute} />
            </>
          )
        }
        onClose={onClose}
      />
      <InspectorFindBar find={find} />
      <LegalReaderAIChat
        activeLegal={activeLegal}
        aiMode="enabled"
        className="min-h-0 flex-1"
        presets={[summarizePreset]}
      >
        <ScrollArea axis="vertical" className="h-full">
          {/* The gutter and the trailing room the composer needs belong to the
              column; the text root inside it carries the reader's own scale. */}
          <div data-slot="reader-document-column">
            {/* The floating bar owns the top row, so the wording starts below
                it rather than under the version and the zoom controls. */}
            <div
              className={cn(
                "flex flex-col gap-6 pb-4",
                VIEWER_OVERLAY_BAR_TOP_CLEARANCE,
              )}
              ref={contentRef}
              {...textScale.rootProps}
            >
              {appliedInDecision && selectedVersion !== undefined && (
                <ProvisionVersionContext
                  currentVersionId={currentVersion?.id}
                  decisionContext={payload.decisionContext}
                  documentId={payload.documentId}
                  expression={selectedVersion}
                  onVersionChange={switchVersion}
                  status={selectedVersion.status}
                  validFrom={selectedVersion.versionValidFrom}
                  validTo={selectedVersion.versionValidTo}
                />
              )}

              <ProvisionWording
                anchorId={payload.anchorId}
                documentId={payload.documentId}
                highlightAnchorId={payload.highlightAnchorId}
              />

              <ProvisionSection
                count={citingCount}
                title={t("caseLaw.viewer.citedBy")}
              >
                {(countsView.type === "error" ||
                  (countsView.type === "items" &&
                    countsView.refetchError !== undefined)) && (
                  <div
                    role="alert"
                    className="text-muted-foreground flex items-center gap-2 text-xs"
                  >
                    {t("errors.actionFailed")}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        detached(
                          countsView.retry(),
                          "statutes.citation-counts-retry",
                        )
                      }
                    >
                      {t("common.retry")}
                    </Button>
                  </div>
                )}
                <ProvisionCitingDecisions
                  anchorId={payload.anchorId}
                  currentVersionValidFrom={
                    selectedVersion?.versionValidFrom ??
                    payload.versionValidFrom
                  }
                  filters={citingFilters}
                  onFiltersChange={(filters) => {
                    detached(
                      navigate({
                        to: ".",
                        search: (previous) =>
                          updateProvisionCitingSearch(previous, filters),
                        replace: true,
                      }),
                      "statutes.citing-decisions-filters",
                    );
                  }}
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
            </div>
          </div>
        </ScrollArea>
        {/* One row, the way the act's own reader carries its path: which
            version is on screen and the others to open or compare, then the
            zoom. */}
        <FloatingZoomControls
          atMax={textScale.atMax}
          atMin={textScale.atMin}
          className="start-2 min-w-0 justify-between text-xs"
          level={textScale.level}
          onReset={textScale.reset}
          onZoom={textScale.zoom}
        >
          <ProvisionVersionBar
            onCompare={openComparison}
            onVersionChange={switchVersion}
            selectedVersion={selectedVersion}
            versions={availableVersions}
          />
        </FloatingZoomControls>
      </LegalReaderAIChat>
    </div>
  );
};

/**
 * The consolidation on screen as one control: its status as a dot, its
 * window as the menu that opens another version or sets one beside it.
 */
const ProvisionVersionBar = ({
  onCompare,
  onVersionChange,
  selectedVersion,
  versions,
}: {
  onCompare: (versionValidFrom: string) => void;
  onVersionChange: (documentId: string) => void;
  selectedVersion: PublicStatuteVersion | undefined;
  versions: readonly PublicStatuteVersion[];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (selectedVersion === undefined) {
    return <span className="min-w-0 flex-1" />;
  }
  const ineligibleLabel = ineligibleExpressionLabelKey(selectedVersion);
  const displayStatus = resolveStatuteDisplayStatus({
    status: selectedVersion.status,
    validFrom: selectedVersion.versionValidFrom,
  });
  let statusLabel = selectedVersion.status;
  if (ineligibleLabel !== null) {
    statusLabel = t(ineligibleLabel);
  } else if (displayStatus !== null) {
    statusLabel = t(STATUTE_STATUS_LABEL_KEYS[displayStatus]);
  }
  const range = formatValidityRange({
    format,
    openEnded: t("statutes.openEnded"),
    validFrom: selectedVersion.versionValidFrom,
    validTo: selectedVersion.versionValidTo,
  });

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 ps-2">
      <span
        aria-label={statusLabel}
        className="flex shrink-0 items-center"
        role="img"
        title={statusLabel}
      >
        <StatuteStatusDot
          expression={selectedVersion}
          status={selectedVersion.status}
          validFrom={selectedVersion.versionValidFrom}
        />
      </span>
      {versions.length > 1 ? (
        <StatuteVersionMenu
          currentVersionId={selectedVersion.id}
          onCompare={onCompare}
          onVersionChange={onVersionChange}
          versions={versions}
        />
      ) : (
        <span className="text-muted-foreground min-w-0 truncate tabular-nums">
          {ineligibleLabel === null
            ? range
            : t("statutes.statedWindow", { range })}
        </span>
      )}
    </span>
  );
};

/**
 * The start the chat offers for this provision: how courts apply it, asked
 * from the passages of its leading decisions so the answer begins with what
 * the courts said and the case-law tools are reached for the rest. The
 * prompt names the provision, which is what those tools look it up by.
 */
const useProvisionSummaryPreset = ({
  passages,
  payload,
}: {
  passages: readonly CitingDecisionRow[];
  payload: ProvisionViewPayload;
}): AISuggestionPreset => {
  const t = useTranslations();
  const format = useFormatter();
  const validFrom = formatValidityDate(payload.versionValidFrom, format);
  const subject =
    validFrom === null
      ? t("statutes.provisionPromptSubjectUndated", {
          eli: payload.eli,
          provision: payload.provisionLabel,
          statute: payload.statuteTitle,
        })
      : t("statutes.provisionPromptSubject", {
          date: validFrom,
          eli: payload.eli,
          provision: payload.provisionLabel,
          statute: payload.statuteTitle,
        });
  const passageLines = passages.flatMap((passage) => {
    if (passage.sentenceText === null) {
      return [];
    }
    const decided = formatValidityDate(passage.decisionDate, format);
    const source =
      decided === null
        ? `${passage.caseNumber} (${passage.court})`
        : `${passage.caseNumber} (${passage.court}, ${decided})`;
    return [`- ${source}: ${passage.sentenceText}`];
  });
  const context =
    passageLines.length === 0
      ? ""
      : t("statutes.provisionAskContextPrompt", {
          passages: passageLines.join("\n"),
        });
  return {
    id: SUMMARIZE_PRESET_ID,
    label: t("statutes.provisionAskSummarize"),
    prompt: `${t("statutes.provisionAskSummarizePrompt", { subject })}${context}`,
  };
};

const ProvisionSection = ({
  children,
  title,
  count = null,
}: {
  children: ReactNode;
  title: string;
  count?: number | null;
}) => {
  const format = useFormatter();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {title}
        {count === null ? null : (
          <span className="ms-2 tabular-nums">{format.number(count)}</span>
        )}
      </h3>
      {children}
    </section>
  );
};
