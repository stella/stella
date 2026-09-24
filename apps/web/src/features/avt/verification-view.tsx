/**
 * AVT verification screen: the document's claims underlined by verdict, the
 * filter and triage toolbar, and the claim detail panel. Sentence granularity
 * and one two-column layout (stacked below `md`).
 */

import * as React from "react";

import { panic } from "better-result";
import {
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  FilterIcon,
  FlagIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { ClaimDetailPanel } from "@/features/avt/claim-detail-panel";
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
  groupClaimsIntoPassages,
  passageReadingOrder,
  spanPresentation,
} from "@/features/avt/verification-view.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";

type VerdictFilter =
  | "all"
  | "conflicts"
  | "needsreview"
  | "reviewed"
  | ClaimState;

type VerificationViewProps = {
  workspaceId: string;
  run: VerificationRun;
};

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
  const passages = groupClaimsIntoPassages(claims);
  const readingOrder = passageReadingOrder(passages);
  const counts = countClaims(run.claims, contested);
  const routineIds = routineUnsettledClaimIds(run.claims, contested);

  const [selected, setSelected] = React.useState(readingOrder.at(0) ?? null);
  const [filter, setFilter] = React.useState<VerdictFilter>("all");

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
    document
      .querySelector(`#${claimDomId(id)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const stepper = matchStepper({
    orderedMatches,
    selected,
    goTo: goToMatch,
  });

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
          {stepper.total > 0 && (
            <div className="flex items-center justify-end border-b px-5 py-2">
              <MatchStepper stepper={stepper} />
            </div>
          )}
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-5">
              {passages.map((passage) => (
                <div className="space-y-1" key={passage.key}>
                  {passage.pageNumber !== null && (
                    <div className="text-muted-foreground text-2xs font-medium">
                      {t("common.page", {
                        page: format.number(passage.pageNumber),
                      })}
                    </div>
                  )}
                  <p
                    className="font-serif text-base leading-relaxed"
                    dir="auto"
                  >
                    {passage.claims.map((claim, index) => {
                      const { dim, highlight } = spanPresentation({
                        filterActive: filter !== "all",
                        matches: matches(claim, filter),
                      });
                      return (
                        <React.Fragment key={claim.id}>
                          {index > 0 && (
                            <span
                              aria-hidden="true"
                              className="text-muted-foreground"
                            >
                              {" … "}
                            </span>
                          )}
                          <ClaimSpan
                            claim={claim}
                            contested={isContested(claim, contested)}
                            dim={dim}
                            highlight={highlight}
                            onSelect={setSelected}
                            selected={claim.id === selected}
                            state={effectiveState(claim, claim.review)}
                          />
                        </React.Fragment>
                      );
                    })}
                  </p>
                </div>
              ))}
              <div className="flex flex-wrap gap-2 border-t pt-3">
                {LEGEND_STATES.map((state) => (
                  <StateChip key={state} state={state} />
                ))}
              </div>
            </div>
          </ScrollArea>
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

const claimDomId = (claimId: string): string => `avt-claim-${claimId}`;

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

type ClaimSpanProps = {
  claim: VerificationClaim;
  state: ClaimState;
  selected: boolean;
  dim: boolean;
  highlight: boolean;
  contested: boolean;
  onSelect: (id: VerificationClaim["id"]) => void;
};

const ClaimSpan = ({
  claim,
  state,
  selected,
  dim,
  highlight,
  contested,
  onSelect,
}: ClaimSpanProps) => {
  const t = useTranslations();
  const reviewStatus = claim.review?.status ?? null;
  const color = STATE_COLOR[state];
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "cursor-pointer rounded px-0.5 text-start underline decoration-2 underline-offset-2",
        color.decorationClass,
        highlight && color.highlightClass,
        dim && "opacity-40",
        selected && "ring-2",
        selected && !highlight && "bg-muted",
      )}
      id={claimDomId(claim.id)}
      onClick={() => onSelect(claim.id)}
      style={{
        ...color.decorationStyle,
        ...(highlight ? color.highlightStyle : undefined),
      }}
      type="button"
    >
      {claim.text}
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
