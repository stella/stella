/**
 * AVT claim detail: the score broken into supporting and conflicting facts,
 * the confidence signal, record-conflict resolution, and the human-review
 * layer. Every reviewer action is recorded against the claim on the server.
 */

import * as React from "react";

import { panic } from "better-result";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  FlagIcon,
  HistoryIcon,
  PenIcon,
  SearchIcon,
  SplitIcon,
  XCircleIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import type { ReviewDecisionState } from "@stll/ui/review-decision-actions";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

import { FactDate } from "@/features/avt/fact-date";
import type { MatchStepperState } from "@/features/avt/state-chip";
import {
  ConfBadge,
  InterpNote,
  MatchStepper,
  MediumChip,
  RECORD_CONFLICT_BG_VAR,
  RECORD_CONFLICT_FG_VAR,
  RECORD_CONFLICT_VAR,
  STATE_COLOR,
  SaveIndicator,
  StateChip,
  TypeChip,
} from "@/features/avt/state-chip";
import type {
  ClaimFactRelation,
  ClaimOverrideState,
  ClaimReview,
  ClaimReviewEvent,
  ClaimReviewStatus,
  ClaimState,
  EvidenceFact,
  FactId,
  RecordConflict,
  VerificationClaim,
} from "@/features/avt/types";
import {
  CLAIM_OVERRIDE_STATES,
  CLAIM_TYPE_META,
  STATE_META,
} from "@/features/avt/types";
import { useClaimSaveState } from "@/features/avt/use-claim-review-actions";
import type { DispositionTone } from "@/features/avt/verdict";
import {
  confirmLabel,
  dispositionGuidance,
  effectiveState,
  isContested,
  isSettled,
} from "@/features/avt/verdict";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type ClaimDetailPanelProps = {
  workspaceId: string;
  runId: string;
  /** The claim as displayed (see `resolveClaimView`). */
  claim: VerificationClaim;
  factsById: ReadonlyMap<FactId, EvidenceFact>;
  contested: ReadonlySet<FactId>;
  stepper: MatchStepperState;
  onReviewEvent: (event: ClaimReviewEvent) => void;
};

export const ClaimDetailPanel = ({
  workspaceId,
  runId,
  claim,
  factsById,
  contested,
  stepper,
  onReviewEvent,
}: ClaimDetailPanelProps) => {
  const t = useTranslations();
  const saveState = useClaimSaveState({ workspaceId, runId }, claim.id);
  // Recording a review changes the document's record, so it needs the same
  // permission the server checks for every review action.
  const canReview = usePermissions({ entity: ["update"] });
  const { review, verdict } = claim;
  const state = effectiveState(claim, review);
  const supports = claim.refs.filter((ref) => ref.rel === "supports");
  const conflicts = claim.refs.filter((ref) => ref.rel === "conflicts");
  const contestedClaim = isContested(claim, contested);
  const settled = isSettled(review);
  const guidance = dispositionGuidance({ state, refs: claim.refs }, contested);
  // Escalating a record conflict hands it to the evidence team: there is no
  // verdict left for this reviewer to confirm or dispute until it is
  // resolved, so those controls go inactive rather than settling the claim.
  const isEscalated = review?.recordConflictResolution?.kind === "escalated";
  const DispositionIcon = DISPOSITION_TONE_STYLE[guidance.tone].icon;
  const override = review?.override ?? null;

  const setStatus = (status: ClaimReviewStatus | null) =>
    onReviewEvent({ kind: "status", status });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip state={state} />
            <TypeChip type={claim.type} />
            {review?.reopened === true && (
              <span title={t("avt.claimDetail.reopenedTooltip")}>
                <ReviewStatusBadge
                  icon={<HistoryIcon aria-hidden="true" className="size-3" />}
                  size="sm"
                  tone="highlight"
                >
                  {t("avt.claimDetail.reopened")}
                </ReviewStatusBadge>
              </span>
            )}
            {override !== null && (
              <span title={t("avt.claimDetail.overrideTooltip")}>
                <ReviewStatusBadge
                  icon={<PenIcon aria-hidden="true" className="size-3" />}
                  size="sm"
                  tone={STATE_COLOR[override].tone}
                >
                  {t("avt.claimDetail.overridden")}
                </ReviewStatusBadge>
              </span>
            )}
            <SaveIndicator state={saveState} />
          </div>
          <MatchStepper stepper={stepper} />
        </div>
        <blockquote
          className="border-foreground-disabled border-s-2 py-0.5 ps-3 font-serif text-base leading-relaxed"
          dir="auto"
        >
          {claim.text}
        </blockquote>
        <p className="text-muted-foreground text-2xs leading-relaxed">
          {t(CLAIM_TYPE_META[claim.type].hintKey)}
        </p>

        {override !== null && (
          <p className="text-muted-foreground text-2xs flex items-start gap-1.5 leading-relaxed">
            <PenIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {t.rich("avt.claimDetail.overrideNotice", {
                strong: (chunks) => <b>{chunks}</b>,
                verdict: t(STATE_META[override].chipKey),
              })}
            </span>
          </p>
        )}

        <ScoreSection
          conflictCount={conflicts.length}
          state={verdict.state}
          score={verdict.score}
          supportCount={supports.length}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {contestedClaim && (
            <InterpNote note={t("avt.claimDetail.interpretationCaveat")} />
          )}

          {verdict.state === "recordconflict" && (
            <RecordConflictBlock
              conflict={verdict.recordConflict}
              disabled={!canReview}
              factsById={factsById}
              onResolve={(resolution) =>
                onReviewEvent({ kind: "record-conflict", resolution })
              }
              review={review}
            />
          )}

          {claim.refs.length > 0 && verdict.state !== "recordconflict" && (
            <section className="space-y-2">
              <h3 className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
                {t("avt.claimDetail.whyScore")}
              </h3>
              {[...supports, ...conflicts].map((ref) => {
                const fact = factsById.get(ref.factEntityId);
                return fact === undefined ? null : (
                  <FactCard fact={fact} key={ref.factEntityId} rel={ref.rel} />
                );
              })}
            </section>
          )}

          <section className="space-y-2.5 border-t pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
                {t("avt.claimDetail.humanReview")}
              </h3>
              {!settled && !isEscalated && (
                <ReviewStatusBadge tone={DISPOSITION_TONE_STYLE[guidance.tone].tone}>
                  {t(guidance.guideKey)}
                </ReviewStatusBadge>
              )}
            </div>
            {isEscalated && (
              <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
                <FlagIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                {t("avt.claimDetail.escalatedReview")}
              </p>
            )}
            {!isEscalated && !settled && (
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
                {t(guidance.askKey)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <DecisionStatus review={review} />
              <ReviewDecisionActions
                acceptLabel={t(confirmLabel(state))}
                disabled={isEscalated || !canReview}
                onAccept={() => setStatus("reviewed")}
                onReject={() => setStatus("disputed")}
                onReopen={() => setStatus(null)}
                rejectLabel={t("avt.claimDetail.flagDispute")}
                reopenLabel={t("avt.review.undo")}
                state={decisionState(review)}
              />
            </div>

            {isScoredState(verdict.state) && (
              <OverrideControl
                disabled={isEscalated || !canReview}
                onOverride={(overrideState) =>
                  onReviewEvent({ kind: "override", state: overrideState })
                }
                override={override}
                toolState={verdict.state}
              />
            )}

            {verdict.state === "notverifiable" && (
              <div className="bg-muted space-y-2 rounded-md border p-3">
                <p className="text-xs leading-relaxed">
                  {t.rich("avt.claimDetail.notVerifiable.reopenExplanation", {
                    strong: (chunks) => <b>{chunks}</b>,
                  })}
                </p>
                <Button
                  disabled={review?.reopened === true || !canReview}
                  onClick={() => onReviewEvent({ kind: "reopen" })}
                  size="sm"
                >
                  <SearchIcon />
                  {t("avt.claimDetail.notVerifiable.reopen")}
                </Button>
              </div>
            )}
            {review?.reopened === true && (
              <p className="text-muted-foreground text-2xs leading-relaxed">
                {t.rich("avt.claimDetail.notVerifiable.reopenedPending", {
                  strong: (chunks) => <b>{chunks}</b>,
                })}
              </p>
            )}

            <NoteSection
              disabled={!canReview}
              onSave={(note) => onReviewEvent({ kind: "note", note })}
              review={review}
            />
          </section>
        </div>
      </ScrollArea>
    </div>
  );
};

type ScoredState = Extract<
  ClaimState,
  "supported" | "tension" | "contradicted"
>;

/** Only a scored verdict can be overridden; the rest have nothing to weigh. */
const isScoredState = (state: ClaimState): state is ScoredState =>
  state === "supported" || state === "tension" || state === "contradicted";

type OverrideControlProps = {
  toolState: ScoredState;
  override: ClaimOverrideState | null;
  disabled: boolean;
  onOverride: (state: ClaimOverrideState | null) => void;
};

/** An override annotates the tool's verdict; picking the tool's own clears it. */
const OverrideControl = ({
  toolState,
  override,
  disabled,
  onOverride,
}: OverrideControlProps) => {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">
        {t("avt.claimDetail.overrideVerdict")}
      </span>
      <Select
        disabled={disabled}
        onValueChange={(value) => {
          if (value === null) {
            return;
          }
          onOverride(value === toolState ? null : value);
        }}
        value={override ?? toolState}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {CLAIM_OVERRIDE_STATES.map((overrideState) => (
            <SelectItem key={overrideState} value={overrideState}>
              {t(STATE_META[overrideState].chipKey)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};

const decisionState = (review: ClaimReview | null): ReviewDecisionState => {
  const status = review?.status ?? null;
  if (status === null) {
    return "pending";
  }
  switch (status) {
    case "reviewed": {
      return "accepted";
    }
    case "disputed": {
      return "rejected";
    }
    default: {
      status satisfies never;
      return panic(`Unhandled review status: ${String(status)}`);
    }
  }
};

const DecisionStatus = ({ review }: { review: ClaimReview | null }) => {
  const t = useTranslations();
  const format = useFormatter();
  if (review === null || review.status === null || review.decidedAt === null) {
    return null;
  }
  const decidedAt = format.dateTime(
    Temporal.Instant.from(review.decidedAt).epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  return (
    <ReviewStatusBadge
      size="sm"
      tone={review.status === "reviewed" ? "success" : "destructive"}
      variant="solid"
    >
      {review.status === "reviewed"
        ? t("avt.review.reviewed", {
            origin: review.statusOrigin ?? "single",
            decidedAt,
          })
        : t("avt.review.disputed", { decidedAt })}
    </ReviewStatusBadge>
  );
};

type NoteSectionProps = {
  disabled: boolean;
  review: ClaimReview | null;
  onSave: (note: string) => void;
};

const NoteSection = ({ review, disabled, onSave }: NoteSectionProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const note = review?.note ?? "";
  const [draft, setDraft] = React.useState<string | null>(null);

  // A note is orthogonal to confirm/dispute: saving one never changes the
  // claim's status.
  if (draft !== null) {
    return (
      <div className="space-y-1.5">
        <Textarea
          aria-label={t("avt.claimDetail.note.add")}
          autoFocus
          dir="auto"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("avt.claimDetail.note.placeholder")}
          value={draft}
        />
        <div className="flex gap-1.5">
          <Button
            disabled={disabled}
            onClick={() => {
              onSave(draft.trim());
              setDraft(null);
            }}
            size="sm"
          >
            {t("avt.claimDetail.note.saveCorrection")}
          </Button>
          <Button onClick={() => setDraft(null)} size="sm" variant="ghost">
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (note === "") {
    return (
      <Button
        className="w-full"
        disabled={disabled}
        onClick={() => setDraft("")}
        variant="outline"
      >
        <PenIcon /> {t("avt.claimDetail.note.add")}
      </Button>
    );
  }

  const noteSavedAt = review?.noteSavedAt ?? null;
  const savedAt =
    noteSavedAt === null
      ? null
      : format.dateTime(
          Temporal.Instant.from(noteSavedAt).epochMilliseconds,
          MEDIUM_DATE_SHORT_TIME_FORMAT,
        );
  return (
    <div className="bg-muted space-y-1 rounded-md p-2.5 text-xs leading-relaxed">
      <b>
        {savedAt === null
          ? t("avt.claimDetail.note.headingUndated")
          : t("avt.claimDetail.note.heading", { savedAt })}
      </b>
      <p className="whitespace-pre-wrap" dir="auto">
        {note}
      </p>
      <Button
        disabled={disabled}
        onClick={() => setDraft(note)}
        size="sm"
        variant="ghost"
      >
        <PenIcon /> {t("common.edit")}
      </Button>
    </div>
  );
};

type DispositionToneStyle = {
  tone: ReviewStatusTone;
  textClass: string;
  textStyle?: React.CSSProperties;
  icon: typeof AlertTriangleIcon;
};

/**
 * Disposition-guidance tone: ready = supported, manual = tension,
 * escalate = record conflict, routine = neutral.
 */
const DISPOSITION_TONE_STYLE: Record<DispositionTone, DispositionToneStyle> = {
  ready: {
    tone: "success",
    textClass: "text-success",
    icon: CheckCircle2Icon,
  },
  manual: {
    tone: "warning",
    textClass: "text-warning",
    icon: AlertTriangleIcon,
  },
  escalate: {
    tone: "highlight",
    textClass: "",
    textStyle: { color: RECORD_CONFLICT_VAR },
    icon: SplitIcon,
  },
  routine: {
    tone: "neutral",
    textClass: "text-muted-foreground",
    icon: CircleDashedIcon,
  },
};

type ScoreSectionProps = {
  state: ClaimState;
  score: number | null;
  supportCount: number;
  conflictCount: number;
};

const ScoreSection = ({
  state,
  score,
  supportCount,
  conflictCount,
}: ScoreSectionProps) => {
  const format = useFormatter();
  const t = useTranslations();

  if (state === "nocover") {
    return (
      <p className="text-muted-foreground bg-muted rounded-md p-3 text-sm leading-relaxed">
        {t.rich("avt.claimDetail.score.noCoverage", {
          strong: (chunks) => <b>{chunks}</b>,
        })}
      </p>
    );
  }

  if (state === "notverifiable") {
    return (
      <p className="text-muted-foreground bg-muted rounded-md p-3 text-sm leading-relaxed">
        {t.rich("avt.claimDetail.score.notVerifiable", {
          strong: (chunks) => <b>{chunks}</b>,
        })}
      </p>
    );
  }

  if (state === "recordconflict" || score === null) {
    return (
      <div className="flex items-end gap-3.5">
        <div
          aria-hidden="true"
          className="text-4xl leading-none font-semibold"
          style={{ color: RECORD_CONFLICT_VAR }}
        >
          —
        </div>
        <div className="text-muted-foreground pb-1 text-xs">
          <b className="text-foreground">
            {t("avt.claimDetail.score.verdictWithheld")}
          </b>
          <br />
          {t("avt.claimDetail.score.anchorFactsDisagree")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-3.5">
        <div className="text-4xl leading-none font-semibold tabular-nums">
          {format.number(score)}
        </div>
        <div className="text-muted-foreground pb-1 text-xs">
          {t.rich("avt.claimDetail.score.outOf100", {
            strong: (chunks) => <b>{chunks}</b>,
          })}
        </div>
      </div>
      <div className="bg-muted h-2 overflow-hidden rounded-full border">
        <div
          className="h-full rounded-full"
          style={{
            backgroundColor: STATE_COLOR[state].swatchStyle.backgroundColor,
            width: `${String(score)}%`,
          }}
        />
      </div>
      <div className="text-muted-foreground flex gap-3.5 text-xs">
        <span>
          {t("avt.claimDetail.score.supportCount", { count: supportCount })}
        </span>
        <span>
          {t("avt.claimDetail.score.conflictCount", { count: conflictCount })}
        </span>
      </div>
    </div>
  );
};

const FactCard = ({
  fact,
  rel,
}: {
  fact: EvidenceFact;
  rel: ClaimFactRelation;
}) => {
  const t = useTranslations();
  const supports = rel === "supports";
  return (
    <article className="overflow-hidden rounded-lg border">
      <div className="bg-muted flex items-center justify-between gap-2 border-b px-3 py-2">
        <ReviewStatusBadge
          icon={
            supports ? (
              <CheckIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <XCircleIcon aria-hidden="true" className="size-3.5" />
            )
          }
          size="sm"
          tone={supports ? "success" : "destructive"}
          variant="solid"
        >
          {t(
            supports
              ? "avt.claimDetail.relation.supports"
              : "avt.claimDetail.relation.conflicts",
          )}
        </ReviewStatusBadge>
        <ConfBadge level={fact.confidence} />
      </div>
      <FactBody fact={fact} />
    </article>
  );
};

const FactBody = ({ fact }: { fact: EvidenceFact }) => {
  const t = useTranslations();
  const quote = fact.sources.find((source) => source.quote !== null)?.quote;
  return (
    <div className="space-y-2 px-3 py-2.5">
      <p className="text-sm leading-relaxed" dir="auto">
        {fact.text}
      </p>
      <MediumChip medium={fact.medium} />
      <InterpNote note={fact.interpretationNote} />
      {quote !== undefined && quote !== null && (
        <p
          className="text-muted-foreground border-s-2 ps-2 text-xs italic"
          dir="auto"
        >
          {quote}
        </p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {fact.evidenceKind !== null && <span>{fact.evidenceKind}</span>}
        <FactDate
          occurredOn={fact.occurredOn}
          precision={fact.occurredOnPrecision}
        />
        {fact.sources.length > 0 && (
          <span>
            {t("avt.claimDetail.sourceCount", { count: fact.sources.length })}
          </span>
        )}
      </div>
    </div>
  );
};

type RecordConflictBlockProps = {
  disabled: boolean;
  conflict: RecordConflict;
  review: ClaimReview | null;
  factsById: ReadonlyMap<FactId, EvidenceFact>;
  onResolve: (
    resolution: Extract<
      ClaimReviewEvent,
      { kind: "record-conflict" }
    >["resolution"],
  ) => void;
};

const RecordConflictBlock = ({
  conflict,
  disabled,
  review,
  factsById,
  onResolve,
}: RecordConflictBlockProps) => {
  const t = useTranslations();
  const resolution = review?.recordConflictResolution ?? null;
  const governingId =
    resolution?.kind === "governed" ? resolution.factEntityId : null;
  const records = conflict.factEntityIds.map((factEntityId, index) => ({
    factEntityId,
    value: conflict.values.at(index) ?? "",
    fact: factsById.get(factEntityId),
  }));
  const governing = records.find(
    (record) => record.factEntityId === governingId,
  );

  return (
    <section className="space-y-3">
      <div
        className="rounded-md border px-3 py-2.5"
        style={{
          color: RECORD_CONFLICT_FG_VAR,
          backgroundColor: RECORD_CONFLICT_BG_VAR,
          borderColor: RECORD_CONFLICT_VAR,
        }}
      >
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <HistoryIcon aria-hidden="true" className="size-3.5" />
          {t("avt.claimDetail.recordConflict.title")}
        </h3>
        <p className="text-foreground mt-1 text-xs leading-relaxed">
          {t.rich("avt.claimDetail.recordConflict.description", {
            strong: (chunks) => <b>{chunks}</b>,
            subject: conflict.subject,
          })}
        </p>
      </div>

      <div className="space-y-2">
        {records.map((record) => (
          <div
            className={cn(
              "space-y-2 rounded-lg p-3",
              governingId === record.factEntityId ? "border-2" : "border",
            )}
            key={record.factEntityId}
            style={
              governingId === record.factEntityId
                ? { borderColor: RECORD_CONFLICT_VAR }
                : undefined
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-lg font-bold"
                dir="auto"
                style={{ color: RECORD_CONFLICT_VAR }}
              >
                {record.value}
              </span>
              <ConfBadge level={record.fact?.confidence ?? null} />
            </div>
            {record.fact !== undefined && <FactBody fact={record.fact} />}
            <Button
              disabled={disabled}
              onClick={() =>
                onResolve(
                  governingId === record.factEntityId
                    ? null
                    : { kind: "governed", factEntityId: record.factEntityId },
                )
              }
              size="sm"
              variant={
                governingId === record.factEntityId ? "default" : "outline"
              }
            >
              <CheckIcon />
              {t("avt.claimDetail.recordConflict.treatAsGoverningRecord")}
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">
          {t("avt.claimDetail.recordConflict.reconcile")}
        </h4>
        <Button
          disabled={disabled}
          onClick={() =>
            onResolve(
              resolution?.kind === "escalated" ? null : { kind: "escalated" },
            )
          }
          variant={
            resolution?.kind === "escalated" ? "destructive" : "outline"
          }
        >
          <FlagIcon />
          {t("avt.claimDetail.recordConflict.flagForEvidenceTeam")}
        </Button>
        {governing !== undefined && (
          <p className="bg-muted text-muted-foreground rounded-md px-2.5 py-2 text-xs leading-relaxed">
            {t.rich("avt.claimDetail.recordConflict.governed", {
              strong: (chunks) => <b>{chunks}</b>,
              value: governing.value,
            })}
          </p>
        )}
        {resolution?.kind === "escalated" && (
          <p className="bg-muted text-muted-foreground rounded-md px-2.5 py-2 text-xs leading-relaxed">
            {t("avt.claimDetail.recordConflict.escalatedNotice")}
          </p>
        )}
      </div>
    </section>
  );
};
