/**
 * AVT — claim detail panel: score broken into supports/conflicts,
 * provenance, confidence signal, record-conflict resolution,
 * time-conflict reconciliation, and the human-review layer.
 *
 * Ported from the prototype's `app/detail.jsx`. The reconcile-timeline
 * here is simplified to a plain slider (Sam's own recommendation is
 * to build generic-first and diverge only where the usability gap is
 * worst — the pixel-precise axis art is exactly that kind of surface
 * to revisit later); the underlying "score as at a chosen date"
 * mechanism is unchanged.
 */

import * as React from "react";

import { panic } from "better-result";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  FileIcon,
  FlagIcon,
  HistoryIcon,
  PenIcon,
  SearchIcon,
  SplitIcon,
  XCircleIcon,
} from "lucide-react";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { cn } from "@stll/ui/lib/utils";

import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useAvtStore } from "@/routes/dev/-components/avt/avt-store";
import { CLAIM_TEXT } from "@/routes/dev/-components/avt/sample-data";
import {
  ConfBadge,
  InterpNote,
  MatchStepper,
  MediumChip,
  RECORD_CONFLICT_BG_VAR,
  RECORD_CONFLICT_FG_VAR,
  RECORD_CONFLICT_VAR,
  STATE_COLOR,
  StateChip,
  TypeChip,
  type MatchStepperState,
} from "@/routes/dev/-components/avt/state-chip";
import type {
  AnchorFact,
  Claim,
  ClaimFactRelation,
  ClaimReview,
  ClaimState,
  RecordConflictBoundary,
} from "@/routes/dev/-components/avt/types";
import {
  CLAIM_TYPE_META,
  EMPTY_REVIEW,
  REVIEWER_OVERRIDE_STATES,
  STATE_META,
} from "@/routes/dev/-components/avt/types";
import {
  confirmLabel,
  dispositionGuidance,
  isContested,
  isSettled,
  type DispositionTone,
} from "@/routes/dev/-components/avt/verdict";

function factById(facts: Record<string, AnchorFact>) {
  return (id: string): AnchorFact | undefined => facts[id];
}

/**
 * Disposition-guidance tone → color/icon. Mirrors the prototype's
 * `.disp-guide.<tone>` / `.rev-hint.<tone>` rules: ready=supported,
 * manual=tension, escalate=recordconflict, routine=neutral.
 */
const DISPOSITION_TONE_STYLE: Record<
  DispositionTone,
  {
    badgeClass: string;
    badgeStyle?: React.CSSProperties;
    textClass: string;
    textStyle?: React.CSSProperties;
    icon: typeof AlertTriangleIcon;
  }
> = {
  ready: {
    badgeClass: "text-success bg-success/10 border-success/32",
    textClass: "text-success",
    icon: CheckCircle2Icon,
  },
  manual: {
    badgeClass: "text-warning bg-warning/10 border-warning/32",
    textClass: "text-warning",
    icon: AlertTriangleIcon,
  },
  escalate: {
    badgeClass: "border-transparent",
    badgeStyle: {
      color: RECORD_CONFLICT_FG_VAR,
      backgroundColor: RECORD_CONFLICT_BG_VAR,
      borderColor: RECORD_CONFLICT_VAR,
    },
    textClass: "",
    textStyle: { color: RECORD_CONFLICT_VAR },
    icon: SplitIcon,
  },
  routine: {
    badgeClass: "text-muted-foreground bg-muted border-border",
    textClass: "text-muted-foreground",
    icon: CircleDashedIcon,
  },
};

function FactCard({ fact, rel }: { fact: AnchorFact; rel: ClaimFactRelation }) {
  const supports = rel === "supports";
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="bg-muted flex items-center justify-between border-b px-3 py-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-bold",
            supports
              ? "text-success bg-success/10"
              : "text-destructive-foreground bg-destructive/10",
          )}
        >
          {supports ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <XCircleIcon className="size-3.5" />
          )}
          {supports ? "Supports" : "Conflicts"}
        </span>
        <ConfBadge level={fact.confidence} />
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-sm leading-relaxed">{fact.fact}</p>
        <MediumChip medium={fact.medium} />
        <InterpNote note={fact.interpNote} />
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="bg-muted border-border rounded px-1.5 py-0.5">
            {fact.kind}
          </span>
          <SourceLink fact={fact} />
          <span>{fact.period}</span>
          <span className="opacity-70">Fact {fact.id}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Source citation label, adapted from the prototype's clickable
 * `<a onClick={() => onSource(f)}>`. It is not wired to a real destination:
 * this build is deliberately client-side/mock-data only (see the AVT
 * findings doc), so there is no real source document to navigate to yet.
 * When AVT is wired against a real Stella document, this is the integration
 * point: Stella already has the resolution mechanism
 * (`apps/web/src/routes/.../justification.tsx`'s `PdfChip`/`DocxQuote`, which
 * scroll/highlight the real PDF or DOCX for a citation), so an `AnchorFact`
 * would need a file/citation reference alongside `source`/`page` to reuse it,
 * not a new mechanism.
 */
function SourceLink({ fact }: { fact: AnchorFact }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1">
      <FileIcon aria-hidden="true" className="size-3" />
      {fact.source}, {fact.page}
    </span>
  );
}

function RecordConflictBlock({
  claim,
  review,
}: {
  claim: Claim;
  review: ClaimReview;
}) {
  const rc = claim.recordConflict;
  const resolveRecordConflict = useAvtStore(
    (state) => state.resolveRecordConflict,
  );
  const facts = useAvtStore((state) => state.facts);
  if (!rc) {
    return null;
  }
  const [factIdA, factIdB] = rc.factIds;
  const factA = factById(facts)(factIdA);
  const factB = factById(facts)(factIdB);
  const resolution = review.recordConflictResolution;
  const governingId =
    resolution?.kind === "governed" ? resolution.factId : null;
  const governingIndex = governingId ? rc.factIds.indexOf(governingId) : -1;
  const governingValue =
    governingIndex >= 0 ? rc.values[governingIndex] : undefined;
  const governingDay =
    governingIndex >= 0 && rc.dates ? rc.dates[governingIndex] : undefined;
  let governedResult: { verdict: ClaimState; note: string } | null = null;
  if (rc.boundary && governingDay !== undefined) {
    governedResult =
      governingDay < rc.boundary.day ? rc.boundary.before : rc.boundary.after;
  }

  return (
    <div className="space-y-3">
      <div
        className="rounded-md border border-transparent px-3 py-2.5"
        style={{
          color: RECORD_CONFLICT_FG_VAR,
          backgroundColor: RECORD_CONFLICT_BG_VAR,
          borderColor: RECORD_CONFLICT_VAR,
        }}
      >
        <div className="flex items-center gap-1.5 text-sm font-bold">
          <HistoryIcon className="size-3.5" /> Conflicting evidence in the
          record
        </div>
        <p className="text-foreground mt-1 text-xs leading-relaxed">
          Two anchor facts speak to the same point — <b>{rc.subject}</b> — but
          disagree. Both are <b>high-confidence</b> sources, so this is not a
          reliability problem: the record itself is internally inconsistent. AVT
          withholds a verdict rather than score the claim, because picking one
          record over the other is a judgement for you to make and record — not
          one the tool should make silently.
        </p>
      </div>

      <div className="space-y-2">
        {[
          { fact: factA, value: rc.values[0], id: factIdA },
          { fact: factB, value: rc.values[1], id: factIdB },
        ].map(({ fact, value, id }) =>
          fact ? (
            <div
              className={cn(
                "rounded-lg p-3",
                governingId === id ? "border-2" : "border",
              )}
              key={id}
              style={
                governingId === id
                  ? { borderColor: RECORD_CONFLICT_VAR }
                  : undefined
              }
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span
                  className="text-lg font-bold"
                  style={{ color: RECORD_CONFLICT_VAR }}
                >
                  {value}
                </span>
                <ConfBadge level={fact.confidence} />
              </div>
              <p className="text-sm">{fact.fact}</p>
              <MediumChip medium={fact.medium} />
              <InterpNote note={fact.interpNote} />
              <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                <span>{fact.kind}</span>
                <SourceLink fact={fact} />
                <span>{fact.period}</span>
                <span className="opacity-70">Fact {fact.id}</span>
              </div>
            </div>
          ) : null,
        )}
      </div>

      {rc.boundary && rc.dates && (
        <div className="space-y-2">
          <div className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
            Why the date decides the verdict
          </div>
          <ConflictDateline
            boundary={rc.boundary}
            dates={rc.dates}
            factIds={rc.factIds}
            governingIndex={governingIndex}
            month={rc.month}
            result={governedResult}
            values={rc.values}
          />
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-semibold">Reconcile the record</div>
        <div className="flex flex-col gap-2">
          {[factIdA, factIdB].map((id) => (
            <Button
              key={id}
              onClick={() =>
                resolveRecordConflict(
                  claim.id,
                  governingId === id ? null : { kind: "governed", factId: id },
                )
              }
              style={
                governingId === id
                  ? {
                      borderColor: RECORD_CONFLICT_VAR,
                      color: RECORD_CONFLICT_VAR,
                    }
                  : undefined
              }
              variant="outline"
            >
              <CheckIcon /> Treat {id}
              {" as "}governing
            </Button>
          ))}
          <Button
            className={cn(
              resolution?.kind === "escalated" &&
                "border-destructive text-destructive-foreground",
            )}
            onClick={() =>
              resolveRecordConflict(
                claim.id,
                resolution?.kind === "escalated" ? null : { kind: "escalated" },
              )
            }
            variant="outline"
          >
            <FlagIcon /> Flag for evidence team
          </Button>
        </div>
        {resolution?.kind === "governed" && governingValue !== undefined && (
          <div className="bg-muted text-muted-foreground rounded-md px-2.5 py-2 text-xs leading-relaxed">
            This local preview treats <b>{governingId}</b>
            {" as "}governing and evaluates the claim against{" "}
            <b>{governingValue}</b>
            {governedResult ? (
              <>
                {" "}
                — landing on <b>{STATE_META[governedResult.verdict].chip}</b>
              </>
            ) : null}
            . Both fixture records remain unchanged.
          </div>
        )}
        {resolution?.kind === "escalated" && (
          <div className="bg-muted text-muted-foreground rounded-md px-2.5 py-2 text-xs leading-relaxed">
            Marked locally for evidence-team follow-up. The record conflict
            remains open and counted until a governing source is selected.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Why the date decides the verdict" — shows where the two disputed
 * dates fall relative to the boundary event (e.g. a board meeting)
 * that determines which side of the boundary controls the outcome.
 * Ported from the prototype's `ConflictDateline`; non-interactive
 * (governance is picked via the buttons below, not by dragging here).
 */
function ConflictDateline({
  boundary,
  dates,
  factIds,
  values,
  governingIndex,
  result,
  month,
}: {
  boundary: RecordConflictBoundary;
  dates: readonly [number, number];
  factIds: readonly [string, string];
  values: readonly [string, string];
  /** Index of the governing record in `dates`/`values`/`factIds`, or -1. */
  governingIndex: number;
  result: { verdict: ClaimState; note: string } | null;
  month: string | undefined;
}) {
  // Select by index, not by day value: `dates` may legitimately hold two
  // equal days, and matching on the value then marks both records as
  // governing and picks the wrong one for the sentence below.
  const governingDate = dates[governingIndex];
  const lo = Math.min(dates[0], dates[1], boundary.day) - 4;
  const hi = Math.max(dates[0], dates[1], boundary.day) + 4;
  const pct = (day: number) => ((day - lo) / (hi - lo)) * 100;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="relative mx-2 h-10">
        <div className="bg-border absolute inset-x-0 top-1/2 h-px" />
        <div
          className="absolute top-0 bottom-0 w-px"
          style={{
            left: `${pct(boundary.day)}%`,
            backgroundColor: RECORD_CONFLICT_VAR,
          }}
        />
        <div
          className="absolute -bottom-5 flex -translate-x-1/2 items-center gap-1 text-[10px] font-semibold whitespace-nowrap"
          style={{ left: `${pct(boundary.day)}%`, color: RECORD_CONFLICT_VAR }}
        >
          <FlagIcon className="size-3" />
          {boundary.day} {month} · {boundary.label}
        </div>
        {[dates[0], dates[1]].map((day, index) => {
          const id = factIds[index];
          const isGoverning = governingIndex === index;
          return (
            <div
              className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
              key={id}
              style={{ left: `${pct(day)}%` }}
            >
              <span className="text-[10px] font-bold whitespace-nowrap">
                {values[index]}
              </span>
              <span
                className={cn(
                  "border-border bg-background size-3 rounded-full border-2",
                  isGoverning && "border-2",
                )}
                style={
                  isGoverning
                    ? {
                        borderColor: RECORD_CONFLICT_VAR,
                        backgroundColor: RECORD_CONFLICT_VAR,
                      }
                    : undefined
                }
              />
            </div>
          );
        })}
        <span className="text-muted-foreground absolute start-0 top-full text-[10px]">
          {lo} {month}
        </span>
        <span className="text-muted-foreground absolute end-0 top-full text-[10px]">
          {hi} {month}
        </span>
      </div>
      {result ? (
        <div className="flex items-start gap-2 text-xs leading-relaxed">
          <StateChip state={result.verdict} />
          <span>
            As at{" "}
            <b>
              {governingDate} {month}
            </b>
            , the {result.note}
          </span>
        </div>
      ) : (
        <p className="text-muted-foreground text-[11.5px] leading-relaxed">
          The two dates fall on <i>opposite sides</i> of the boundary event.
          Whichever record governs decides the outcome — so resolving the
          conflict here directly sets the verdict.
        </p>
      )}
    </div>
  );
}

function reconcileVerdict(
  day: number,
): Extract<ClaimState, "supported" | "contradicted" | "nocover"> {
  const supStart = 2;
  const supEnd = 20;
  const conDay = 25;
  if (day >= conDay) {
    return "contradicted";
  }
  if (day >= supStart && day <= supEnd) {
    return "supported";
  }
  return "nocover";
}

const RECONCILE_LABELS = {
  supported: "Supported",
  contradicted: "Contradicted",
  nocover: "No coverage",
} as const;

function ReconcileTimeline() {
  const [day, setDay] = React.useState(25);
  const verdict = reconcileVerdict(day);
  const label = RECONCILE_LABELS[verdict];
  return (
    <div className="border-primary/32 mt-2.5 space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between text-xs">
        <span>
          As at <b>{day} Aug 2021</b>
        </span>
        <StateChip state={verdict} />
      </div>
      <input
        aria-label="As-at date"
        className="w-full"
        max={31}
        min={1}
        onChange={(event) => setDay(Number(event.target.value))}
        type="range"
        value={day}
      />
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        Preview the claim against the fixture record <i>{"as at"}</i> a chosen
        date. Preview verdict: <b>{label}</b>.
      </p>
    </div>
  );
}

function ScoreSection({
  claim,
  supportCount,
  conflictCount,
}: {
  claim: Claim;
  supportCount: number;
  conflictCount: number;
}) {
  const format = useFormatter();

  if (claim.state === "nocover") {
    return (
      <div className="text-muted-foreground bg-muted flex gap-2.5 rounded-md p-3 text-sm leading-relaxed">
        <div>
          <b>The record is silent.</b> No anchor fact in the database addresses
          this claim. This is distinct from a weak score — it means there is
          nothing to check it against yet.
        </div>
      </div>
    );
  }

  if (claim.state === "notverifiable") {
    return (
      <div className="text-muted-foreground bg-muted flex gap-2.5 rounded-md p-3 text-sm leading-relaxed">
        <div>
          <b>Not a verifiable assertion.</b> This is the kind of statement no
          document could ever settle — a counterfactual, a prediction, a
          statement of intent, a legal conclusion, or a claim too vague to
          check. Set aside rather than scored.
        </div>
      </div>
    );
  }

  if (claim.state === "recordconflict") {
    return (
      <div className="flex items-end gap-3.5">
        <div
          className="text-4xl leading-none font-semibold"
          style={{ color: RECORD_CONFLICT_VAR }}
        >
          —
        </div>
        <div className="text-muted-foreground pb-1 text-xs">
          <b className="text-foreground">Verdict withheld</b>
          <br />
          Anchor facts disagree
        </div>
      </div>
    );
  }

  // Unreachable: the three checks above already excluded every unscored
  // state. Checking `score` itself (rather than another `state` literal)
  // is what lets TS narrow it to `number` below — narrowing a union by
  // peeling off one discriminant literal at a time, as above, doesn't
  // propagate to a sibling field the way checking that field directly does.
  if (claim.score === null) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-3.5">
        <div className="text-4xl leading-none font-semibold">
          {format.number(claim.score)}
        </div>
        <div className="text-muted-foreground pb-1 text-xs">
          <b>/ 100</b> support score
        </div>
      </div>
      <div className="bg-muted h-2 overflow-hidden rounded-full border">
        <div
          className="h-full rounded-full"
          style={{
            backgroundColor:
              STATE_COLOR[claim.state].swatchStyle.backgroundColor,
            width: `${claim.score}%`,
          }}
        />
      </div>
      <div className="text-muted-foreground flex gap-3.5 text-xs">
        <span>{format.number(supportCount)} support</span>
        <span>{format.number(conflictCount)} conflict</span>
      </div>
    </div>
  );
}

export function ClaimDetailPanel({
  claim,
  stepper,
}: {
  claim: Claim;
  stepper?: MatchStepperState;
}) {
  const facts = useAvtStore((state) => state.facts);
  const reviews = useAvtStore((state) => state.reviews);
  const setReviewStatus = useAvtStore((state) => state.setReviewStatus);
  const setOverride = useAvtStore((state) => state.setOverride);
  const setNote = useAvtStore((state) => state.setNote);
  const reopenClaim = useAvtStore((state) => state.reopenClaim);
  const format = useFormatter();

  const [noteOpen, setNoteOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const review = reviews[claim.id] ?? EMPTY_REVIEW;
  const text = CLAIM_TEXT[claim.id] ?? "";
  const supports = claim.refs.filter((ref) => ref.rel === "supports");
  const conflicts = claim.refs.filter((ref) => ref.rel === "conflicts");
  const hasFacts = claim.refs.length > 0;
  const contested = isContested(claim, factById(facts));
  const settled = isSettled(review);
  const guidance = dispositionGuidance(claim, factById(facts));
  // Escalating a record conflict hands it to someone senior — there is no
  // verdict left for this reviewer to confirm or dispute yet, so those
  // controls go inactive (not hidden, so it stays clear why) rather than
  // marking the claim settled: it still needs the underlying conflict
  // resolved before it can leave the queue.
  const isEscalated = review.recordConflictResolution?.kind === "escalated";
  const DispositionIcon = DISPOSITION_TONE_STYLE[guidance.tone].icon;

  // Saving a note never changes review status on its own — a note is
  // orthogonal to Confirm/Dispute, not an implicit way to trigger one.
  // Previously any saved note force-set status to "reviewed", which could
  // silently overwrite an existing "disputed" status the moment you added
  // an explanatory note to it.
  const saveNote = () => {
    setNote(claim.id, draft.trim());
    setNoteOpen(false);
  };

  let noteSection: React.ReactNode;
  if (noteOpen) {
    noteSection = (
      <div className="space-y-1.5">
        <Textarea
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          // Describes what saving actually does. The inherited copy
          // promised that saving updated the anchor-fact record and
          // re-scored affected claims; nothing does either, and attaching
          // evidence to a claim is still an open design question (see the
          // "no coverage" note in the handover doc).
          placeholder="Record a correction or an explanation. Saving records the note against this claim only — it does not change the verdict or the anchor-fact record."
          value={draft}
        />
        <div className="flex gap-1.5">
          <Button onClick={saveNote} size="sm">
            Save correction
          </Button>
          <Button
            onClick={() => {
              setNoteOpen(false);
              setDraft(review.note);
            }}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  } else if (review.note) {
    noteSection = (
      <div className="bg-muted rounded-md p-2.5 text-xs leading-relaxed">
        <b>
          Your note ·{" "}
          {format.dateTime(
            Temporal.Instant.from(
              review.savedAt ?? panic("Saved AVT note has no timestamp"),
            ).epochMilliseconds,
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          )}
        </b>
        <br />
        {review.note}
        <Button
          onClick={() => {
            setDraft(review.note);
            setNoteOpen(true);
          }}
          size="sm"
          variant="ghost"
        >
          <PenIcon /> Edit
        </Button>
      </div>
    );
  } else {
    noteSection = (
      <Button
        className="w-full"
        onClick={() => setNoteOpen(true)}
        variant="outline"
      >
        <PenIcon /> Add note / correction
      </Button>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip state={claim.state} />
            <TypeChip type={claim.type} />
            {review.reopened && (
              <span
                className="bg-primary/10 text-primary border-primary/32 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold"
                title="A reviewer re-classified this as a checkable fact; a live record check is still pending."
              >
                <HistoryIcon className="size-3" /> Re-opened, check pending
              </span>
            )}
            {review.override && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold",
                  STATE_COLOR[review.override].chipClass,
                )}
                style={STATE_COLOR[review.override].chipStyle}
                title="A reviewer has recorded a different verdict. The analysis below is the tool's own, unchanged."
              >
                <PenIcon className="size-3" /> Overridden
              </span>
            )}
          </div>
          {stepper && <MatchStepper stepper={stepper} />}
        </div>
        <p className="border-foreground-disabled border-s-2 py-0.5 ps-3 font-serif text-base leading-relaxed">
          &ldquo;{text}&rdquo;
        </p>
        <p className="text-muted-foreground text-[11.5px] leading-relaxed">
          {CLAIM_TYPE_META[claim.type].hint}
        </p>

        {review.override && (
          <div
            className={cn(
              "flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-[11.5px] leading-relaxed",
              STATE_COLOR[review.override].chipClass,
            )}
            style={STATE_COLOR[review.override].chipStyle}
          >
            <PenIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Overridden to <b>{STATE_META[review.override].chip}</b> — the
              analysis below is the tool&rsquo;s own, shown unchanged.
            </span>
          </div>
        )}

        <ScoreSection
          claim={claim}
          conflictCount={conflicts.length}
          supportCount={supports.length}
        />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {contested && (
          <InterpNote note="A contributing fact carries a substantive interpretation caveat — what the evidence means, not the medium it came in, is what is uncertain." />
        )}

        {claim.superseded && (
          <div className="text-primary bg-primary/10 border-primary/32 rounded-md border px-3 py-2.5 text-xs leading-relaxed">
            <div className="mb-1 flex items-center gap-1.5 font-bold">
              <HistoryIcon className="size-3.5" /> Revised in a later statement
            </div>
            {claim.superseded.note}
          </div>
        )}

        {claim.state === "recordconflict" && (
          <RecordConflictBlock claim={claim} review={review} />
        )}

        {hasFacts && claim.state !== "recordconflict" && (
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
              Why this score — anchor facts
            </div>
            {supports.map((ref) => {
              const fact = factById(facts)(ref.factId);
              return fact ? (
                <FactCard fact={fact} key={ref.factId} rel="supports" />
              ) : null;
            })}
            {conflicts.map((ref) => {
              const fact = factById(facts)(ref.factId);
              return fact ? (
                <FactCard fact={fact} key={ref.factId} rel="conflicts" />
              ) : null;
            })}
          </div>
        )}

        {claim.timeConflict && <ReconcileTimeline />}

        <div className="space-y-2.5 border-t pt-3.5">
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
              Human review
            </div>
            {!settled && !isEscalated && (
              <span
                className={cn(
                  "rounded border px-2 py-0.5 text-[10.5px] font-bold tracking-wide uppercase",
                  DISPOSITION_TONE_STYLE[guidance.tone].badgeClass,
                )}
                style={DISPOSITION_TONE_STYLE[guidance.tone].badgeStyle}
              >
                {guidance.guide}
              </span>
            )}
          </div>
          {isEscalated ? (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
              <FlagIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              Escalated to the evidence team — no verdict to confirm or dispute
              here until the underlying conflict is resolved.
            </p>
          ) : (
            !settled && (
              <p
                className={cn(
                  "flex items-start gap-1.5 text-xs leading-relaxed",
                  DISPOSITION_TONE_STYLE[guidance.tone].textClass,
                )}
                style={DISPOSITION_TONE_STYLE[guidance.tone].textStyle}
              >
                <DispositionIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                {guidance.ask}
              </p>
            )
          )}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={isEscalated}
              onClick={() =>
                setReviewStatus(
                  claim.id,
                  review.status === "reviewed" ? null : "reviewed",
                )
              }
              variant={review.status === "reviewed" ? "default" : "outline"}
            >
              <CheckIcon /> {confirmLabel(claim.state)}
            </Button>
            <Button
              className="flex-1"
              disabled={isEscalated}
              onClick={() =>
                setReviewStatus(
                  claim.id,
                  review.status === "disputed" ? null : "disputed",
                )
              }
              variant={review.status === "disputed" ? "destructive" : "outline"}
            >
              <FlagIcon /> Flag dispute
            </Button>
          </div>

          {claim.state !== "nocover" &&
            claim.state !== "notverifiable" &&
            claim.state !== "recordconflict" && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  Override verdict
                </span>
                <Select
                  disabled={isEscalated}
                  onValueChange={(value) => {
                    if (value !== null) {
                      setOverride(
                        claim.id,
                        value === claim.state ? null : value,
                      );
                    }
                  }}
                  value={review.override ?? claim.state}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEWER_OVERRIDE_STATES.map((state) => (
                      <SelectItem key={state} value={state}>
                        {STATE_META[state].chip}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

          {claim.state === "notverifiable" && (
            <div className="border-border bg-muted space-y-2 rounded-md border p-3">
              <p className="text-xs leading-relaxed">
                <b>{"Set aside as not verifiable."}</b> If this is actually a
                checkable claim, re-open it: AVT keeps your reclassification and
                runs only the record-check it skipped.
              </p>
              <Button onClick={() => reopenClaim(claim.id)} size="sm">
                <SearchIcon /> Re-open → check against record
              </Button>
              {review.reopened && (
                <p className="text-muted-foreground text-[11px] leading-relaxed">
                  No live model wired up in this build — landed on{" "}
                  <b>No coverage, pending check</b>.
                </p>
              )}
            </div>
          )}

          {noteSection}
        </div>
      </div>
    </div>
  );
}
