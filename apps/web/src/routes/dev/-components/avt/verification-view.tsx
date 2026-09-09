/**
 * AVT — verification screen: document with claim spans, filter/triage
 * toolbar, and the claim detail panel. Ported from the prototype's
 * `app/verification.jsx`.
 *
 * Scope note (generic-first per Jan's steer): the original supports a
 * sentence/paragraph granularity toggle and three panel layouts
 * (columns/focus/inspector). This pass keeps sentence granularity and
 * a single two-column layout — the document/detail wiring and the
 * triage logic are what this build is proving out; the extra layout
 * chrome is exactly the kind of surface to diverge on later, once a
 * real usability gap shows up.
 */

import * as React from "react";

import {
  CheckIcon,
  EyeIcon,
  FilterIcon,
  FlagIcon,
  HistoryIcon,
  ScaleIcon,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useFormatter } from "@/i18n/formatting-context";
import { useAvtStore } from "@/routes/dev/-components/avt/avt-store";
import { ClaimDetailPanel } from "@/routes/dev/-components/avt/claim-detail-panel";
import {
  CLAIM_TEXT,
  CLAIMS,
  DOCUMENT,
} from "@/routes/dev/-components/avt/sample-data";
import {
  MatchStepper,
  STATE_COLOR,
  StateChip,
  StateSwatch,
  type MatchStepperState,
} from "@/routes/dev/-components/avt/state-chip";
import {
  STATE_META,
  type AnchorFact,
  type Claim,
  type ClaimReview,
  type ClaimState,
} from "@/routes/dev/-components/avt/types";
import {
  countClaims,
  effectiveState,
  isContested,
  isSettled,
  needsAttention,
  resolveClaimView,
} from "@/routes/dev/-components/avt/verdict";
import { spanPresentation } from "@/routes/dev/-components/avt/verification-view.logic";

type VerdictFilter =
  | "all"
  | "conflicts"
  | "needsreview"
  | "reviewed"
  | ClaimState;

/** Claim ids in document reading order — distinct from CLAIMS' declaration order (c14 reads before c4, for example). */
const DOCUMENT_CLAIM_ORDER: readonly string[] = DOCUMENT.paragraphs.flatMap(
  (paragraph) =>
    paragraph.segments
      .filter(
        (segment): segment is { claimId: string } =>
          typeof segment !== "string",
      )
      .map((segment) => segment.claimId),
);

const claimDomId = (claimId: string): string => `avt-claim-${claimId}`;

function ClaimSpan({
  claimId,
  state,
  selected,
  dim,
  highlight,
  contested,
  superseded,
  reviewStatus,
  onSelect,
}: {
  claimId: string;
  state: ClaimState;
  selected: boolean;
  dim: boolean;
  highlight: boolean;
  contested: boolean;
  superseded: boolean;
  reviewStatus: "reviewed" | "disputed" | null;
  onSelect: (id: string) => void;
}) {
  const text = CLAIM_TEXT[claimId] ?? "";
  return (
    <button
      className={cn(
        "cursor-pointer rounded px-0.5 underline decoration-2 underline-offset-2",
        STATE_COLOR[state].decorationClass,
        highlight && STATE_COLOR[state].highlightClass,
        dim && "opacity-40",
        selected && "ring-2",
        selected && !highlight && "bg-muted",
      )}
      id={claimDomId(claimId)}
      onClick={() => onSelect(claimId)}
      style={{
        ...STATE_COLOR[state].decorationStyle,
        ...(highlight ? STATE_COLOR[state].highlightStyle : undefined),
      }}
      type="button"
    >
      {text}
      {contested && (
        <ScaleIcon
          aria-hidden="true"
          className="text-warning ms-0.5 inline-block size-3 align-middle"
        />
      )}
      {superseded && (
        <HistoryIcon
          aria-hidden="true"
          className="text-primary ms-0.5 inline-block size-3 align-middle"
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
      {/*
        Everything above that carries meaning — the verdict colour, the
        underline, and each marker icon — is purely visual, and the icons
        are aria-hidden. Without this a screen-reader user hears the claim
        text alone and cannot tell a supported claim from a contradicted
        one, or see that it is contested, superseded or already reviewed,
        without selecting it first.
      */}
      <span className="sr-only">
        {` (${STATE_META[state].chip}`}
        {contested ? ", contested" : ""}
        {superseded ? ", superseded" : ""}
        {reviewStatus === "reviewed" ? ", reviewed" : ""}
        {reviewStatus === "disputed" ? ", disputed" : ""}
        {")"}
      </span>
    </button>
  );
}

function claimMatchesFilter(
  claim: Claim,
  filterValue: VerdictFilter,
  review: ClaimReview | undefined,
  factById: (id: string) => AnchorFact | undefined,
): boolean {
  const state = effectiveState(claim, review);
  if (filterValue === "all") {
    return true;
  }
  if (filterValue === "conflicts") {
    return (
      state === "contradicted" ||
      state === "tension" ||
      state === "recordconflict"
    );
  }
  if (filterValue === "needsreview") {
    return (
      needsAttention({ state, refs: claim.refs }, factById) &&
      !isSettled(review)
    );
  }
  if (filterValue === "reviewed") {
    return isSettled(review);
  }
  return state === filterValue;
}

export function VerificationView() {
  const format = useFormatter();
  const facts = useAvtStore((state) => state.facts);
  const reviews = useAvtStore((state) => state.reviews);
  const bulkSetReviewed = useAvtStore((state) => state.bulkSetReviewed);

  const [selected, setSelected] = React.useState(CLAIMS[0]?.id ?? "");
  const [filter, setFilter] = React.useState<VerdictFilter>("all");

  const factById = React.useCallback((id: string) => facts[id], [facts]);

  /**
   * Resolve every claim once, here, so that everything downstream agrees
   * about what a claim currently is. Reopening reclassifies a claim (to
   * `nocover`, with no refs); resolving only where a single claim is
   * rendered left the detail panel showing the reopened claim while the
   * stat tiles, filters and document underlines still described its
   * original state.
   */
  const resolvedById = React.useMemo(
    () =>
      new Map(
        CLAIMS.map((claim) => [
          claim.id,
          resolveClaimView(claim, reviews[claim.id]),
        ]),
      ),
    [reviews],
  );

  const resolvedClaims = React.useMemo(
    () => [...resolvedById.values()],
    [resolvedById],
  );

  const counts = React.useMemo(
    () => countClaims(CLAIMS, reviews, factById),
    [reviews, factById],
  );

  const matchesFilterValue = React.useCallback(
    (claim: Claim, filterValue: VerdictFilter) =>
      claimMatchesFilter(claim, filterValue, reviews[claim.id], factById),
    [reviews, factById],
  );

  const matchesFilter = React.useCallback(
    (claimId: string): boolean => {
      const claim = resolvedById.get(claimId);
      return claim ? matchesFilterValue(claim, filter) : false;
    },
    [filter, matchesFilterValue, resolvedById],
  );

  const routineUnsettledIds = resolvedClaims
    .filter((claim) => {
      const review = reviews[claim.id];
      const state = effectiveState(claim, review);
      return (
        !needsAttention({ state, refs: claim.refs }, factById) &&
        !isSettled(review)
      );
    })
    .map((claim) => claim.id);

  const selectedClaim = resolvedById.get(selected);

  // Changing the filter can leave the current selection no longer
  // matching it — keep the preview pane relevant by jumping to the
  // first claim (in document order) that does match, rather than
  // leaving a filtered-out claim stuck in the detail panel.
  const applyFilter = (nextFilter: VerdictFilter) => {
    setFilter(nextFilter);
    if (selectedClaim && matchesFilterValue(selectedClaim, nextFilter)) {
      return;
    }
    // Walk DOCUMENT_CLAIM_ORDER, not CLAIMS: the comment above promises
    // the first match *in document order*, and the two orders genuinely
    // differ (c14 reads before c4). Resolve each claim before testing it,
    // for the same reason everything else here does — otherwise a
    // reopened claim is judged on the state it no longer has, and can be
    // selected while the document and filter both show it as no match.
    const firstMatchId = DOCUMENT_CLAIM_ORDER.find((id) => {
      const claim = resolvedById.get(id);
      return claim ? matchesFilterValue(claim, nextFilter) : false;
    });
    if (firstMatchId !== undefined) {
      setSelected(firstMatchId);
    }
  };

  // Reading-order list of the active filter's matches, for the N/M
  // stepper — lets a reviewer step through matches without scanning
  // the document by eye. Only meaningful once a filter narrows things
  // down; "all" has no bounded set worth stepping through.
  const orderedMatches = React.useMemo(
    () =>
      filter === "all"
        ? []
        : DOCUMENT_CLAIM_ORDER.filter((id) => {
            const claim = resolvedById.get(id);
            return claim ? matchesFilterValue(claim, filter) : false;
          }),
    [filter, matchesFilterValue, resolvedById],
  );

  const goToMatch = (id: string) => {
    setSelected(id);
    document
      .querySelector(`#${claimDomId(id)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // `.at()` keeps this a plain lookup rather than an unsafe cast — an
  // out-of-range index (shouldn't happen, given the guards below) just
  // yields a disabled arrow instead of a runtime error.
  const stepTo = (index: number): (() => void) | null => {
    const id = orderedMatches.at(index);
    return id ? () => goToMatch(id) : null;
  };

  const currentMatchIndex = orderedMatches.indexOf(selected);
  let stepper: MatchStepperState = {
    current: null,
    total: 0,
    onPrev: null,
    onNext: null,
  };
  if (orderedMatches.length > 0) {
    if (currentMatchIndex === -1) {
      // Selection isn't among the current matches (e.g. a dimmed claim was
      // clicked directly) — both directions stay usable, just without a
      // well-defined position to display.
      stepper = {
        current: null,
        total: orderedMatches.length,
        onPrev: stepTo(-1),
        onNext: stepTo(0),
      };
    } else {
      stepper = {
        current: currentMatchIndex + 1,
        total: orderedMatches.length,
        onPrev: currentMatchIndex > 0 ? stepTo(currentMatchIndex - 1) : null,
        onNext:
          currentMatchIndex < orderedMatches.length - 1
            ? stepTo(currentMatchIndex + 1)
            : null,
      };
    }
  }

  const stats: {
    key: string;
    label: string;
    value: string;
    filter: VerdictFilter;
    state?: ClaimState;
  }[] = [
    {
      key: "total",
      label: "Claims",
      value: format.number(counts.total),
      filter: "all",
    },
    {
      key: "contradicted",
      label: "Contradicted",
      value: format.number(counts.byState.contradicted),
      filter: "contradicted",
      state: "contradicted",
    },
    {
      key: "tension",
      label: "In tension",
      value: format.number(counts.byState.tension),
      filter: "tension",
      state: "tension",
    },
    {
      key: "supported",
      label: "Supported",
      value: format.number(counts.byState.supported),
      filter: "supported",
      state: "supported",
    },
    {
      key: "recordconflict",
      label: "Record conflict",
      value: format.number(counts.byState.recordconflict),
      filter: "recordconflict",
      state: "recordconflict",
    },
    {
      key: "nocover",
      label: "No coverage",
      value: format.number(counts.byState.nocover),
      filter: "nocover",
      state: "nocover",
    },
    {
      key: "notverifiable",
      label: "Not verifiable",
      value: format.number(counts.byState.notverifiable),
      filter: "notverifiable",
      state: "notverifiable",
    },
    // Progress through the claims that actually need a human, which is
    // what the triage model is for. Labelled "Needs judgement" rather
    // than "Reviewed" because the count deliberately excludes the routine
    // tail: after bulk-accepting the routine claims this still read
    // "0/8 Reviewed" while seven claims were plainly reviewed, and
    // clicking it filtered to all seven — a tile appearing to contradict
    // its own filter. Clicking now shows the outstanding claims the
    // number is counting down.
    {
      key: "needsjudgement",
      label: "Needs judgement",
      value: `${format.number(counts.attnSettled)}/${format.number(counts.attnTotal)}`,
      filter: "needsreview",
    },
  ];

  return (
    <div className="flex h-[calc(100dvh-8rem)] flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{DOCUMENT.title}</h2>
        <p className="text-muted-foreground text-xs">{DOCUMENT.meta}</p>
      </div>

      <div className="grid grid-cols-4 gap-0 overflow-hidden rounded-xl border sm:grid-cols-8">
        {stats.map((stat) => (
          <button
            className={cn(
              "hover:bg-muted border-e p-2.5 text-start last:border-e-0",
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
                stat.state && STATE_COLOR[stat.state].textClass,
              )}
              style={stat.state && STATE_COLOR[stat.state].textStyle}
            >
              {stat.value}
            </div>
            <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              {stat.state && <StateSwatch state={stat.state} />}
              {stat.label}
            </div>
          </button>
        ))}
      </div>

      <div className="bg-muted flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs">
        <FilterIcon className="size-3.5 shrink-0" />
        {counts.attnOpen > 0 ? (
          <span>
            <b>
              {format.number(counts.attnOpen)} claim
              {counts.attnOpen === 1 ? "" : "s"} need your judgement
            </b>{" "}
            — conflicts and contested interpretations. The other{" "}
            {format.number(counts.routineTotal)} are routine and don't need
            individual sign-off.
          </span>
        ) : (
          <span>
            <b>Every claim needing judgement has been dispositioned.</b> The{" "}
            {format.number(counts.routineTotal)} routine determinations don't
            require individual review.
          </span>
        )}
        <div className="flex-1" />
        {counts.attnOpen > 0 && (
          <Button
            onClick={() =>
              applyFilter(filter === "needsreview" ? "all" : "needsreview")
            }
            size="sm"
            variant="link"
          >
            {filter === "needsreview" ? "Show all" : "Show queue"}
          </Button>
        )}
        {counts.routineUnsettled > 0 && (
          <Button
            onClick={() => bulkSetReviewed(routineUnsettledIds)}
            size="sm"
            variant="outline"
          >
            <CheckIcon /> Accept {format.number(counts.routineUnsettled)}{" "}
            routine
          </Button>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_420px] gap-3">
        <div className="min-h-0 overflow-y-auto rounded-xl border">
          {stepper.total > 0 && (
            <div className="bg-background/95 sticky top-0 z-10 flex items-center justify-end border-b px-5 py-2 backdrop-blur-sm">
              <MatchStepper stepper={stepper} />
            </div>
          )}
          <div className="p-5">
            {DOCUMENT.paragraphs.map((paragraph) => (
              <p
                className="mb-4 font-serif text-[15px] leading-relaxed last:mb-0"
                key={paragraph.id}
              >
                {paragraph.segments.map((segment) => {
                  if (typeof segment === "string") {
                    return (
                      <span
                        className="text-muted-foreground"
                        key={`${paragraph.id}:${segment}`}
                      >
                        {segment}
                      </span>
                    );
                  }
                  const claim = resolvedById.get(segment.claimId);
                  if (!claim) {
                    return null;
                  }
                  const review = reviews[claim.id];
                  const { dim, highlight } = spanPresentation({
                    filterActive: filter !== "all",
                    matches: matchesFilter(segment.claimId),
                  });
                  return (
                    <ClaimSpan
                      claimId={segment.claimId}
                      contested={isContested(claim, factById)}
                      dim={dim}
                      highlight={highlight}
                      key={segment.claimId}
                      onSelect={setSelected}
                      reviewStatus={review?.status ?? null}
                      selected={segment.claimId === selected}
                      state={effectiveState(claim, review)}
                      superseded={Boolean(claim.superseded)}
                    />
                  );
                })}
              </p>
            ))}
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
              {Object.values(STATE_META).map((meta) => (
                <StateChip key={meta.state} state={meta.state} />
              ))}
            </div>
          </div>
        </div>

        <div className="min-h-0 overflow-hidden rounded-xl border">
          {selectedClaim ? (
            <ClaimDetailPanel
              claim={selectedClaim}
              key={selectedClaim.id}
              stepper={stepper}
            />
          ) : (
            <div className="text-muted-foreground p-4 text-sm">
              Select a claim to inspect the record.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
