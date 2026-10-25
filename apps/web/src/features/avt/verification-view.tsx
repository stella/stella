/**
 * AVT verification screen: the document's text in the shared legal reader
 * with its claims underlined by verdict, the filter and triage toolbar, and
 * the claim detail panel. Sentence granularity and one two-column layout
 * (stacked below `md`).
 */

import * as React from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { LiteralTextProvider } from "@stll/decision-reader/display-elision-policy";
import { BlockRenderer } from "@stll/decision-reader/document-ast-text";
import { Button } from "@stll/ui/button";
import {
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  FilterIcon,
  FlagIcon,
} from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";
import { textMarkClass } from "@stll/ui/text-mark";
import type { TextMarkState } from "@stll/ui/text-mark";
import { cn } from "@stll/ui/utils";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { ClaimDetailPanel } from "@/features/avt/claim-detail-panel";
import type { OriginalClaimMark } from "@/features/avt/original-claims";
import type { OriginalScrollTarget } from "@/features/avt/original-docx-view";
import { isPdfClaimBoxDrawn } from "@/features/avt/original-pdf-claim-box";
import type { MatchStepperState } from "@/features/avt/state-chip";
import {
  MatchStepper,
  STATE_COLOR,
  StateChip,
  StateSwatch,
} from "@/features/avt/state-chip";
import type {
  ClaimState,
  FactId,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";
import { STATE_META } from "@/features/avt/types";
import { useClaimReviewActions } from "@/features/avt/use-claim-review-actions";
import {
  contestedFactIds,
  countClaims,
  effectiveState,
  evidenceFactsById,
  isConflictState,
  isContested,
  isSettled,
  needsAttention,
  resolveClaimView,
  routineUnsettledClaimIds,
} from "@/features/avt/verdict";
import {
  claimMark,
  originalKind,
  selectClaimPresentation,
  spanPresentation,
} from "@/features/avt/verification-view.logic";
import type { ClaimPresentation } from "@/features/avt/verification-view.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";

// Folio and the file viewer load only when someone opens the original.
const OriginalDocxView = React.lazy(async () => {
  const m = await import("@/features/avt/original-docx-view");
  return { default: m.OriginalDocxView };
});
const OriginalPdfView = React.lazy(async () => {
  const m = await import("@/features/avt/original-pdf-view");
  return { default: m.OriginalPdfView };
});

/** The reader's text of the stored blocks, or the file as it is laid out. */
type DocumentView = "reading" | "original";

type VerdictFilter =
  "all" | "conflicts" | "needsreview" | "reviewed" | ClaimState;

type VerificationViewProps = {
  workspaceId: string;
  run: VerificationRun;
};

type OriginalDocumentProps = React.ComponentProps<typeof OriginalDocxView> & {
  kind: "docx" | "pdf";
};

/** The file as it is laid out, with the claims drawn over it. */
const OriginalDocument = ({
  kind,
  scrollTarget,
  ...props
}: OriginalDocumentProps) => (
  <div className="min-h-0 flex-1">
    <React.Suspense fallback={<Skeleton className="h-full w-full" />}>
      {kind === "pdf" ? (
        <OriginalPdfView {...props} />
      ) : (
        <OriginalDocxView {...props} scrollTarget={scrollTarget} />
      )}
    </React.Suspense>
  </div>
);

export const VerificationView = ({
  workspaceId,
  run,
}: VerificationViewProps) => {
  const format = useFormatter();
  const t = useTranslations();
  const canReview = usePermissions({ entity: ["update"] });
  const { recordEvent, acceptRoutine } = useClaimReviewActions({
    workspaceId,
    runId: run.id,
  });

  // Resolve every claim once, so the document, the stat tiles, the filters
  // and the detail panel agree about what each claim currently is.
  const claims = run.claims.map(resolveClaimView);
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const contested = contestedFactIds(run.evidence.facts);
  const factsById = evidenceFactsById(run.evidence);
  const presentation = selectClaimPresentation(run.blocks, claims);
  const readingOrder = presentation.readingOrder;
  const counts = countClaims(run.claims, contested);
  const routineIds = routineUnsettledClaimIds(run.claims, contested);

  const [selected, setSelected] = React.useState(readingOrder.at(0) ?? null);
  const [filter, setFilter] = React.useState<VerdictFilter>("all");
  const [documentView, setDocumentView] =
    React.useState<DocumentView>("reading");
  // Where the DOCX original should bring the reader next. It is held, not
  // fired, so a step taken while the original is still loading lands once
  // the viewer has the document.
  const [originalScroll, setOriginalScroll] =
    React.useState<OriginalScrollTarget | null>(null);
  const original = originalKind(run.blocks);
  const hasOriginal = original !== null;
  const view = hasOriginal ? documentView : "reading";

  const matches = (claim: VerificationClaim, value: VerdictFilter) =>
    claimMatchesFilter(claim, value, contested);

  const selectedClaim = selected === null ? undefined : claimById.get(selected);

  // A filter that no longer matches the selection jumps to its first match in
  // reading order, so the detail pane stays relevant.
  const applyFilter = (next: VerdictFilter) => {
    setFilter(next);
    if (selectedClaim !== undefined && matches(selectedClaim, next)) {
      return;
    }
    const firstMatch = readingOrder.find((id) => {
      const claim = claimById.get(id);
      return claim !== undefined && matches(claim, next);
    });
    if (firstMatch !== undefined) {
      setSelected(firstMatch);
    }
  };

  const orderedMatches =
    filter === "all"
      ? []
      : readingOrder.filter((id) => {
          const claim = claimById.get(id);
          return claim !== undefined && matches(claim, filter);
        });

  const goToMatch = (id: VerificationClaim["id"]) => {
    setSelected(id);
    if (view === "original") {
      const claim = claimById.get(id);
      if (claim !== undefined) {
        scrollOriginalToClaim(claim);
      }
      return;
    }
    document
      .querySelector(`#${claimDomId(id)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // Bring the original to a claim's block or page. Both requests are held
  // while the document is still loading: the block as state the DOCX view
  // applies once Folio has the document, the page in the inspector store the
  // PDF viewer reads. On a PDF the claim's box brings itself into view once
  // its page is drawn; when the box is already drawn it alone scrolls, since
  // a page request would realign the page top over it.
  const scrollOriginalToClaim = (claim: VerificationClaim) => {
    if (claim.anchor.type === "pdf-page") {
      if (isPdfClaimBoxDrawn(claim.id)) {
        return;
      }
      useInspectorCommandStore.getState().requestPdfPageScroll({
        tabId: run.fileFieldId,
        pageNumber: claim.anchor.pageNumber,
      });
      return;
    }
    // A new target for every request, so stepping back onto the same block
    // scrolls again.
    setOriginalScroll({ blockId: claim.anchor.blockId });
  };

  // The original opens on the selected claim, as the reading view shows it;
  // a step taken in an earlier visit is not replayed.
  const openDocumentView = (next: DocumentView) => {
    setDocumentView(next);
    setOriginalScroll(null);
    if (next === "original" && selectedClaim !== undefined) {
      scrollOriginalToClaim(selectedClaim);
    }
  };

  const stepper = matchStepper({
    orderedMatches,
    selected,
    goTo: goToMatch,
  });

  // One claim mark, wherever the pane draws it: over the reader's text, or
  // on its own in a passage.
  const renderClaim = (claim: VerificationClaim, children: React.ReactNode) => {
    const { dim, highlight } = spanPresentation({
      filterActive: filter !== "all",
      matches: matches(claim, filter),
    });
    return (
      <ClaimSpan
        claim={claim}
        contested={isContested(claim, contested)}
        dim={dim}
        highlight={highlight}
        onSelect={setSelected}
        selected={claim.id === selected}
        state={effectiveState(claim, claim.review)}
      >
        {children}
      </ClaimSpan>
    );
  };

  // The same claim mark over the original's painted pages.
  const originalMark = (claim: VerificationClaim): OriginalClaimMark => {
    const { dim, highlight } = spanPresentation({
      filterActive: filter !== "all",
      matches: matches(claim, filter),
    });
    return {
      state: effectiveState(claim, claim.review),
      mark: claimMark({ selected: claim.id === selected, dim, highlight }),
    };
  };

  const stats: {
    key: string;
    label: string;
    value: string;
    filter: VerdictFilter;
    state?: ClaimState;
  }[] = [
    {
      key: "total",
      label: t("avt.verification.stats.claims"),
      value: format.number(counts.total),
      filter: "all",
    },
    ...STAT_STATES.map((state) => ({
      key: state,
      label: t(STATE_META[state].chipKey),
      value: format.number(counts.byState[state]),
      filter: state,
      state,
    })),
    // Progress through the claims that need a human, which is what the
    // triage model is for: the routine tail is deliberately left out, and
    // the tile filters to the outstanding claims it counts down.
    {
      key: "needsjudgement",
      label: t("avt.verification.stats.needsJudgement"),
      value: t("avt.verification.stats.progress", {
        settled: format.number(counts.attnSettled),
        total: format.number(counts.attnTotal),
      }),
      filter: "needsreview",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid grid-cols-4 overflow-hidden rounded-xl border md:grid-cols-8">
        {stats.map((stat) => (
          <button
            aria-pressed={filter === stat.filter}
            className={cn(
              "hover:bg-muted border-e border-b p-2.5 text-start md:border-b-0 md:last:border-e-0",
              filter === stat.filter && "bg-muted",
            )}
            key={stat.key}
            onClick={() =>
              applyFilter(filter === stat.filter ? "all" : stat.filter)
            }
            type="button"
          >
            <div
              className={cn(
                "text-lg font-semibold tabular-nums",
                stat.state !== undefined && STATE_COLOR[stat.state].textClass,
              )}
              style={
                stat.state === undefined
                  ? undefined
                  : STATE_COLOR[stat.state].textStyle
              }
            >
              {stat.value}
            </div>
            <div className="text-muted-foreground text-2xs flex items-center gap-1.5">
              {stat.state !== undefined && <StateSwatch state={stat.state} />}
              {stat.label}
            </div>
          </button>
        ))}
      </div>

      <div className="bg-muted flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2 text-xs">
        <FilterIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {counts.attnOpen > 0
            ? t.rich("avt.verification.attentionOpen", {
                count: counts.attnOpen,
                routineCount: counts.routineTotal,
                strong: (chunks) => <b>{chunks}</b>,
              })
            : t.rich("avt.verification.attentionComplete", {
                count: counts.routineTotal,
                strong: (chunks) => <b>{chunks}</b>,
              })}
        </span>
        {counts.attnOpen > 0 && (
          <Button
            onClick={() =>
              applyFilter(filter === "needsreview" ? "all" : "needsreview")
            }
            size="sm"
            variant="link"
          >
            {filter === "needsreview"
              ? t("common.showAll")
              : t("avt.verification.showQueue")}
          </Button>
        )}
        {routineIds.length > 0 && (
          <Button
            disabled={!canReview}
            onClick={() => acceptRoutine(routineIds)}
            size="sm"
            variant="outline"
          >
            <CheckIcon />
            {t("avt.verification.acceptRoutine", { count: routineIds.length })}
          </Button>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-5">
        <div className="flex h-96 flex-col overflow-hidden rounded-xl border md:col-span-3 md:h-auto md:min-h-0">
          {(hasOriginal || stepper.total > 0) && (
            <div
              className={cn(
                "flex flex-wrap items-center gap-2 border-b px-3 py-2",
                hasOriginal ? "justify-between" : "justify-end",
              )}
            >
              {hasOriginal && (
                <Tabs onValueChange={openDocumentView} value={view}>
                  <TabsList
                    aria-label={t("avt.verification.documentView.label")}
                  >
                    <TabsTab value="reading">
                      {t("avt.verification.documentView.reading")}
                    </TabsTab>
                    <TabsTab value="original">
                      {t("avt.verification.documentView.original")}
                    </TabsTab>
                  </TabsList>
                </Tabs>
              )}
              {stepper.total > 0 && <MatchStepper stepper={stepper} />}
            </div>
          )}
          {view === "original" && original !== null ? (
            <OriginalDocument
              claims={claims}
              kind={original}
              markOf={originalMark}
              onSelect={setSelected}
              run={run}
              scrollTarget={originalScroll}
              selected={selected}
              workspaceId={workspaceId}
            />
          ) : (
            <ReadingDocument
              presentation={presentation}
              renderClaim={renderClaim}
            />
          )}
        </div>

        <div className="flex flex-col overflow-hidden rounded-xl border md:col-span-2 md:min-h-0">
          {selectedClaim === undefined ? (
            <p className="text-muted-foreground p-4 text-sm">
              {t("avt.verification.selectClaim")}
            </p>
          ) : (
            <ClaimDetailPanel
              claim={selectedClaim}
              contested={contested}
              factsById={factsById}
              key={selectedClaim.id}
              onReviewEvent={(event) => recordEvent(selectedClaim.id, event)}
              runId={run.id}
              stepper={stepper}
              workspaceId={workspaceId}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const STAT_STATES = [
  "contradicted",
  "tension",
  "supported",
  "recordconflict",
  "nocover",
  "notverifiable",
] as const satisfies readonly ClaimState[];

true satisfies Exclude<ClaimState, (typeof STAT_STATES)[number]> extends never
  ? true
  : never;

const LEGEND_STATES = STAT_STATES;

// The pane has no find bar: the reader draws no search marks.
const NO_RANGES = {};
const NO_ACTIVE_MATCH = -1;

/** The reader's body typography, as the statute reader sets it. */
const READER_STYLE = {
  fontFamily: "var(--reader-body-font)",
  fontSize: "var(--reader-body-size)",
  lineHeight: "var(--reader-body-line-height)",
} as const;

const claimDomId = (claimId: string): string => `avt-claim-${claimId}`;

type ReadingDocumentProps = {
  presentation: ClaimPresentation;
  renderClaim: (
    claim: VerificationClaim,
    children: React.ReactNode,
  ) => React.ReactElement;
};

/** The stored text in the shared reader, or the claims' own passages. */
const ReadingDocument = ({
  presentation,
  renderClaim,
}: ReadingDocumentProps) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-4 p-5">
        {presentation.type === "prose" ? (
          // The shared reader draws the stored text; each claim is a
          // text anchor over its block, so the marks sit on the same
          // offsets the server stored.
          <LiteralTextProvider>
            <div className="space-y-4" style={READER_STYLE}>
              {presentation.blocks.map((block) => (
                <div
                  className="space-y-1 whitespace-pre-wrap"
                  key={block.ordinal}
                >
                  {block.pageNumber !== null && (
                    <div className="text-muted-foreground text-2xs font-sans font-medium">
                      {t("common.page", {
                        page: format.number(block.pageNumber),
                      })}
                    </div>
                  )}
                  <div dir="auto">
                    <BlockRenderer
                      activeMatchIndex={NO_ACTIVE_MATCH}
                      anchorPresentation="embedded"
                      anchorsByPieceId={{
                        [block.paragraph.id]: block.claimSpans.map(
                          ({ claim, start, end }) => ({
                            start,
                            end,
                            key: claim.id,
                            render: (children) => renderClaim(claim, children),
                          }),
                        ),
                      }}
                      block={block.paragraph}
                      rangesByPieceId={NO_RANGES}
                      variant="case-law"
                    />
                  </div>
                </div>
              ))}
            </div>
          </LiteralTextProvider>
        ) : (
          presentation.passages.map((passage) => (
            <div className="space-y-1" key={passage.key}>
              {passage.pageNumber !== null && (
                <div className="text-muted-foreground text-2xs font-medium">
                  {t("common.page", {
                    page: format.number(passage.pageNumber),
                  })}
                </div>
              )}
              <p className="font-serif text-base leading-relaxed" dir="auto">
                {passage.claims.map((claim, index) => (
                  <React.Fragment key={claim.id}>
                    {index > 0 && (
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground"
                      >
                        {" … "}
                      </span>
                    )}
                    {renderClaim(claim, claim.text)}
                  </React.Fragment>
                ))}
              </p>
            </div>
          ))
        )}
        <div className="flex flex-wrap gap-2 border-t pt-3">
          {LEGEND_STATES.map((state) => (
            <StateChip key={state} state={state} />
          ))}
        </div>
      </div>
    </ScrollArea>
  );
};

const claimMatchesFilter = (
  claim: VerificationClaim,
  filter: VerdictFilter,
  contested: ReadonlySet<FactId>,
): boolean => {
  const state = effectiveState(claim, claim.review);
  switch (filter) {
    case "all": {
      return true;
    }
    case "conflicts": {
      return isConflictState(state);
    }
    case "needsreview": {
      return (
        needsAttention({ state, refs: claim.refs }, contested) &&
        !isSettled(claim.review)
      );
    }
    case "reviewed": {
      return isSettled(claim.review);
    }
    case "supported":
    case "tension":
    case "contradicted":
    case "nocover":
    case "notverifiable":
    case "recordconflict": {
      return state === filter;
    }
    default: {
      filter satisfies never;
      return panic(`Unhandled verdict filter: ${String(filter)}`);
    }
  }
};

type MatchStepperArgs = {
  orderedMatches: readonly VerificationClaim["id"][];
  selected: VerificationClaim["id"] | null;
  goTo: (id: VerificationClaim["id"]) => void;
};

/** Stepper position and prev/next among the active filter's matches. */
const matchStepper = ({
  orderedMatches,
  selected,
  goTo,
}: MatchStepperArgs): MatchStepperState => {
  if (orderedMatches.length === 0) {
    return { current: null, total: 0, onPrev: null, onNext: null };
  }
  const stepTo = (index: number): (() => void) | null => {
    const id = orderedMatches.at(index);
    return id === undefined ? null : () => goTo(id);
  };
  const index = selected === null ? -1 : orderedMatches.indexOf(selected);
  if (index === -1) {
    // The selection is not among the matches (a dimmed claim was clicked):
    // both directions stay usable, without a position to show.
    return {
      current: null,
      total: orderedMatches.length,
      onPrev: stepTo(-1),
      onNext: stepTo(0),
    };
  }
  return {
    current: index + 1,
    total: orderedMatches.length,
    onPrev: index > 0 ? stepTo(index - 1) : null,
    onNext: index < orderedMatches.length - 1 ? stepTo(index + 1) : null,
  };
};

type ClaimMarkStateArgs = {
  selected: boolean;
  highlight: boolean;
};

/** The selected claim is the one being pointed at; a claim the active
 *  filter matches is picked out with a wash of its verdict's hue. */
const claimMarkState = ({
  selected,
  highlight,
}: ClaimMarkStateArgs): TextMarkState => {
  if (selected) {
    return "active";
  }
  return highlight ? "matched" : "rest";
};

type ClaimSpanProps = {
  claim: VerificationClaim;
  state: ClaimState;
  selected: boolean;
  dim: boolean;
  highlight: boolean;
  contested: boolean;
  onSelect: (id: VerificationClaim["id"]) => void;
  /** The claim's words, as the reader or the passage drew them. */
  children: React.ReactNode;
};

const ClaimSpan = ({
  claim,
  state,
  selected,
  dim,
  highlight,
  contested,
  onSelect,
  children,
}: ClaimSpanProps) => {
  const t = useTranslations();
  const reviewStatus = claim.review?.status ?? null;
  const { mark, markTextClass } = STATE_COLOR[state];
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "inline cursor-pointer text-start whitespace-pre-wrap hover:decoration-4 focus-visible:outline-2 focus-visible:outline-offset-2",
        textMarkClass({
          ...mark,
          state: claimMarkState({ selected, highlight }),
        }),
        markTextClass,
        dim && "opacity-40",
      )}
      id={claimDomId(claim.id)}
      onClick={() => onSelect(claim.id)}
      type="button"
    >
      {children}
      {contested && (
        <CircleAlertIcon
          aria-hidden="true"
          className="text-warning ms-0.5 inline-block size-3 align-middle"
        />
      )}
      {reviewStatus === "reviewed" && (
        <EyeIcon
          aria-hidden="true"
          className="text-muted-foreground ms-0.5 inline-block size-3 align-middle"
        />
      )}
      {reviewStatus === "disputed" && (
        <FlagIcon
          aria-hidden="true"
          className="text-destructive-foreground ms-0.5 inline-block size-3 align-middle"
        />
      )}
      {/* The verdict colour, the underline and each marker are visual only;
          a screen-reader user hears the verdict and markers here. */}
      <span className="sr-only">
        {t("avt.verification.claimAnnouncement", {
          state: t(STATE_META[state].chipKey),
          contested: String(contested),
          reviewStatus: reviewStatus ?? "none",
        })}
      </span>
    </button>
  );
};
