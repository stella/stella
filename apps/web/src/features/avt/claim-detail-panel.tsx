/**
 * AVT claim detail: the verdict with its qualifiers, the facts it rests on,
 * the confidence signal, record-conflict resolution, and the human-review
 * layer. A verdict shows as its category only; its 0-100 score stays in the
 * API and exports. Every reviewer action is recorded against the claim on the
 * server; an action that changes the verdict asks for its reason inline, and
 * the claim's history lists every action with the reason given.
 */

import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  FileSearchIcon,
  FlagIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PenIcon,
  SearchIcon,
  SplitIcon,
  XCircleIcon,
  XIcon,
} from "@stll/ui/icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import type {
  ReviewDecisionEmphasis,
  ReviewDecisionState,
} from "@stll/ui/review-decision-actions";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { ListSourceForm } from "@/components/workspaces/list-source-form";
import { ClaimComments } from "@/features/avt/claim-comments";
import {
  GapNextSteps,
  LinkedFacts,
  LinkedMark,
  RecheckSummary,
} from "@/features/avt/claim-gap";
import {
  isRecordSilent,
  QualifierChips,
  QualifierNotes,
  VerdictChip,
} from "@/features/avt/claim-qualifiers";
import { readConflictValue } from "@/features/avt/conflict-value.logic";
import { FactDate, useFactDateText } from "@/features/avt/fact-date";
import { EvidenceFactSource } from "@/features/avt/fact-source";
import { evidenceQuoteSource } from "@/features/avt/fact-source.logic";
import { FactTierLabel } from "@/features/avt/fact-tier";
import { avtKeys } from "@/features/avt/queries";
import { ReasonField } from "@/features/avt/reason-field";
import { ClaimHistory } from "@/features/avt/review-history";
import type { MatchStepperState } from "@/features/avt/state-chip";
import {
  ConfBadge,
  InterpNote,
  MatchStepper,
  RECORD_CONFLICT_BG_VAR,
  RECORD_CONFLICT_FG_VAR,
  RECORD_CONFLICT_VAR,
  SaveIndicator,
  STATE_COLOR,
  TypeChip,
} from "@/features/avt/state-chip";
import type {
  ClaimFactRelation,
  ClaimOverrideState,
  ClaimReview,
  ClaimReviewEvent,
  ClaimReviewStatus,
  ClaimState,
  FactId,
  RecordConflict,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";
import {
  CLAIM_OVERRIDE_STATES,
  REVIEW_STATUS_META,
  STATE_META,
} from "@/features/avt/types";
import { useClaimSaveState } from "@/features/avt/use-claim-review-actions";
import type { DispositionTone, ShownFact } from "@/features/avt/verdict";
import {
  confirmLabel,
  dispositionGuidance,
  effectiveState,
  isContested,
  isSettled,
} from "@/features/avt/verdict";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type ClaimDetailPanelProps = {
  workspaceId: string;
  /** The run, and the list it checked against, which owns its facts'
   *  sources and is where a gap's fact is added or linked from. */
  run: Pick<VerificationRun, "id" | "evidence">;
  /** The claim as displayed (see `resolveClaimView`). */
  claim: VerificationClaim;
  factsById: ReadonlyMap<FactId, ShownFact>;
  contested: ReadonlySet<FactId>;
  stepper: MatchStepperState;
  onReviewEvent: (event: ClaimReviewEvent) => void;
};

export const ClaimDetailPanel = ({
  workspaceId,
  run,
  claim,
  factsById,
  contested,
  stepper,
  onReviewEvent,
}: ClaimDetailPanelProps) => {
  const t = useTranslations();
  const runId = run.id;
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
  const guidance = dispositionGuidance(
    {
      state,
      refs: claim.refs,
      qualifiers: claim.qualifiers,
      recheck: claim.recheck,
    },
    contested,
  );
  // Escalating a record conflict hands it to the evidence team: there is no
  // verdict left for this reviewer to confirm or dispute until it is
  // resolved, so those controls go inactive rather than settling the claim.
  const isEscalated = review?.recordConflictResolution?.kind === "escalated";
  const override = review?.override ?? null;

  const setStatus = (status: ClaimReviewStatus | null) => {
    onReviewEvent({ kind: "status", status });
  };
  const factScope = { workspaceId, listId: run.evidence.listId, runId };
  // The facts the verdict cites, each shown once under it; a record
  // conflict shows its facts in its own block instead.
  const cited = new Map(
    verdict.state === "recordconflict"
      ? []
      : claim.refs.flatMap((ref) => {
          const fact = factsById.get(ref.factEntityId);
          return fact === undefined ? [] : [[ref.factEntityId, fact] as const];
        }),
  );
  // Coverage the record should give leads with filling it; the review
  // decisions step back to quiet controls.
  const gap = state === "nocover" && !isRecordSilent(state, claim);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictChip claim={claim} state={state} />
            <QualifierChips claim={claim} />
            <TypeChip type={claim.type} />
            <ReviewMarks
              override={override}
              reopened={review?.reopened === true}
            />
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
        <QualifierNotes claim={claim} />

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

        <VerdictBasis
          claim={claim}
          conflictCount={conflicts.length}
          supportCount={supports.length}
        />
        {claim.recheck !== null && (
          <RecheckSummary recheck={claim.recheck} state={claim.verdict.state} />
        )}
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
              onResolve={(resolution, reason) =>
                onReviewEvent({ kind: "record-conflict", resolution, reason })
              }
              review={review}
              scope={factScope}
              suggestedFactId={claim.suggestedGoverningFactId}
            />
          )}

          <VerdictFacts
            canReview={canReview}
            claim={claim}
            cited={cited}
            refs={[...supports, ...conflicts]}
            scope={factScope}
          />

          <LinkedFacts
            {...factScope}
            cited={cited}
            claim={claim}
            disabled={!canReview}
          />

          <section className="space-y-2.5 border-t pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
                {t("avt.claimDetail.humanReview")}
              </h3>
              {!settled && !isEscalated && guidance.guideKey !== null && (
                <ReviewStatusBadge
                  tone={DISPOSITION_TONE_STYLE[guidance.tone].tone}
                >
                  {t(guidance.guideKey)}
                </ReviewStatusBadge>
              )}
            </div>
            <ReviewAsk
              asking={!settled || gap}
              escalated={isEscalated}
              guidance={guidance}
            />
            <ReviewActions
              acceptLabel={t(confirmLabel(state, guidance.tone))}
              canReview={canReview}
              claim={claim}
              escalated={isEscalated}
              gap={gap}
              onStatus={setStatus}
              scope={factScope}
              state={state}
            />

            {isScoredState(verdict.state) && (
              <OverrideControl
                disabled={isEscalated || !canReview}
                onOverride={(overrideState, reason) =>
                  onReviewEvent({
                    kind: "override",
                    state: overrideState,
                    reason,
                  })
                }
                override={override}
                toolState={verdict.state}
              />
            )}

            {verdict.state === "notverifiable" && (
              <ReopenControl
                disabled={review?.reopened === true || !canReview}
                onReopen={(reason) => onReviewEvent({ kind: "reopen", reason })}
              />
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

          <ClaimHistory claim={claim} runId={runId} workspaceId={workspaceId} />

          {/* Keyed by the claim, so a comment being written on one claim is
              discarded rather than saved onto the next one selected. */}
          <ClaimComments
            claim={claim}
            key={`${runId}:${claim.id}`}
            runId={runId}
            workspaceId={workspaceId}
          />
        </div>
      </ScrollArea>
    </div>
  );
};

/** Marks on the claim's own review: reopened, and a verdict overridden. */
const ReviewMarks = ({
  reopened,
  override,
}: {
  reopened: boolean;
  override: ClaimOverrideState | null;
}) => {
  const t = useTranslations();
  return (
    <>
      {reopened && (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <ReviewStatusBadge
              icon={<HistoryIcon aria-hidden="true" className="size-3" />}
              size="sm"
              tone="highlight"
            >
              {t("avt.claimDetail.reopened")}
            </ReviewStatusBadge>
          </TooltipTrigger>
          <TooltipPopup>{t("avt.claimDetail.reopenedTooltip")}</TooltipPopup>
        </Tooltip>
      )}
      {override !== null && (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <ReviewStatusBadge
              icon={<PenIcon aria-hidden="true" className="size-3" />}
              size="sm"
              tone={STATE_COLOR[override].tone}
            >
              {t("avt.claimDetail.overridden")}
            </ReviewStatusBadge>
          </TooltipTrigger>
          <TooltipPopup>{t("avt.claimDetail.overrideTooltip")}</TooltipPopup>
        </Tooltip>
      )}
    </>
  );
};

/** What the reviewer is asked: that it was handed on when escalated, else
 *  the disposition's question while there is one to answer. */
const ReviewAsk = ({
  escalated,
  asking,
  guidance,
}: {
  escalated: boolean;
  asking: boolean;
  guidance: ReturnType<typeof dispositionGuidance>;
}) => {
  const t = useTranslations();
  if (escalated) {
    return (
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
        <FlagIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t("avt.claimDetail.escalatedReview")}
      </p>
    );
  }
  if (!asking) {
    return null;
  }
  const style = DISPOSITION_TONE_STYLE[guidance.tone];
  const Icon = style.icon;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs leading-relaxed",
        style.textClass,
      )}
      style={style.textStyle}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {t(guidance.askKey)}
    </p>
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
  onOverride: (state: ClaimOverrideState | null, reason: string) => void;
};

/**
 * An override annotates the tool's verdict; picking the tool's own clears it.
 * Either changes the verdict a reviewer reads, so the pick waits for its
 * reason beside the control before it is recorded.
 */
const OverrideControl = ({
  toolState,
  override,
  disabled,
  onOverride,
}: OverrideControlProps) => {
  const t = useTranslations();
  const current = override ?? toolState;
  const [picked, setPicked] = React.useState<ClaimOverrideState | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {t("avt.claimDetail.overrideVerdict")}
        </span>
        <OverrideSelect
          disabled={disabled}
          onPick={(value) => setPicked(value === current ? null : value)}
          value={picked ?? current}
        />
      </div>
      {picked !== null && (
        <ReasonField
          disabled={disabled}
          label={
            picked === toolState
              ? t("avt.reason.withdrawOverride")
              : t("avt.reason.override", {
                  verdict: t(STATE_META[picked].chipKey),
                })
          }
          onCancel={() => setPicked(null)}
          onSubmit={(reason) => {
            onOverride(picked === toolState ? null : picked, reason);
            setPicked(null);
          }}
          submitLabel={t("common.save")}
        />
      )}
    </div>
  );
};

type OverrideSelectProps = {
  value: ClaimOverrideState;
  disabled: boolean;
  onPick: (value: ClaimOverrideState) => void;
};

const OverrideSelect = ({ value, disabled, onPick }: OverrideSelectProps) => {
  const t = useTranslations();
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) {
          onPick(next);
        }
      }}
      value={value}
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
  );
};

type ReopenControlProps = {
  disabled: boolean;
  onReopen: (reason: string) => void;
};

/** Reclassifying a set-aside claim as checkable, with the reviewer's reason. */
const ReopenControl = ({ disabled, onReopen }: ReopenControlProps) => {
  const t = useTranslations();
  const [asking, setAsking] = React.useState(false);
  return (
    <div className="bg-muted space-y-2 rounded-md border p-3">
      <p className="text-xs leading-relaxed">
        {t.rich("avt.claimDetail.notVerifiable.reopenExplanation", {
          strong: (chunks) => <b>{chunks}</b>,
        })}
      </p>
      {asking ? (
        <ReasonField
          disabled={disabled}
          label={t("avt.reason.reopen")}
          onCancel={() => setAsking(false)}
          onSubmit={(reason) => {
            onReopen(reason);
            setAsking(false);
          }}
          submitLabel={t("avt.claimDetail.notVerifiable.reopen")}
        />
      ) : (
        <Button disabled={disabled} onClick={() => setAsking(true)} size="sm">
          <SearchIcon />
          {t("avt.claimDetail.notVerifiable.reopen")}
        </Button>
      )}
    </div>
  );
};

type ReviewActionsProps = {
  scope: { workspaceId: string; listId: string; runId: string };
  claim: VerificationClaim;
  state: ClaimState;
  /** Coverage the record should give: its next steps lead. */
  gap: boolean;
  acceptLabel: string;
  canReview: boolean;
  escalated: boolean;
  onStatus: (status: ClaimReviewStatus | null) => void;
};

/**
 * What a reviewer can do with the claim. A gap leads with adding the
 * missing fact; while it is undecided, the decision pair folds into the
 * next steps' menu so nothing out-weighs that.
 */
const ReviewActions = ({
  scope,
  claim,
  state,
  gap,
  acceptLabel,
  canReview,
  escalated,
  onStatus,
}: ReviewActionsProps) => {
  const { review } = claim;
  const decisionDisabled = escalated || !canReview;
  const folded = gap && decisionState(review) === "pending";
  return (
    <>
      {state === "nocover" && (
        <GapNextSteps
          {...scope}
          claim={claim}
          disabled={!canReview}
          more={
            folded ? (
              <DecisionMenu
                acceptLabel={acceptLabel}
                disabled={decisionDisabled}
                onStatus={onStatus}
              />
            ) : null
          }
          needsEvidence={
            gap
              ? {
                  marked: review?.status === "needs-evidence",
                  onChange: (marked) =>
                    onStatus(marked ? "needs-evidence" : null),
                }
              : null
          }
        />
      )}
      {!folded && (
        <DecisionRow
          acceptLabel={acceptLabel}
          disabled={decisionDisabled}
          emphasis={gap ? "quiet" : "primary"}
          needsEvidenceControl={!gap}
          onStatus={onStatus}
          review={review}
        />
      )}
    </>
  );
};

/** The decision pair behind one quiet control. */
const DecisionMenu = ({
  acceptLabel,
  disabled,
  onStatus,
}: {
  acceptLabel: string;
  disabled: boolean;
  onStatus: (status: ClaimReviewStatus) => void;
}) => {
  const t = useTranslations();
  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.actions")}
        disabled={disabled}
        render={<Button size="icon-sm" variant="ghost" />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem onClick={() => onStatus("reviewed")}>
          <CheckIcon />
          {acceptLabel}
        </MenuItem>
        <MenuItem onClick={() => onStatus("disputed")}>
          <XIcon />
          {t("avt.claimDetail.flagDispute")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};

type DecisionRowProps = {
  review: ClaimReview | null;
  acceptLabel: string;
  disabled: boolean;
  emphasis: ReviewDecisionEmphasis;
  /** Off where a gap's next steps offer it. */
  needsEvidenceControl: boolean;
  onStatus: (status: ClaimReviewStatus | null) => void;
};

/** The claim's status, the decision pair, and, while undecided, marking it
 *  as needing evidence: open until the record can answer it, so it stays in
 *  the queue and out of routine acceptance. */
const DecisionRow = ({
  review,
  acceptLabel,
  disabled,
  emphasis,
  needsEvidenceControl,
  onStatus,
}: DecisionRowProps) => {
  const t = useTranslations();
  const state = decisionState(review);
  const needsEvidence = review?.status === "needs-evidence";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DecisionStatus review={review} />
      <ReviewDecisionActions
        acceptLabel={acceptLabel}
        disabled={disabled}
        emphasis={emphasis}
        onAccept={() => onStatus("reviewed")}
        onReject={() => onStatus("disputed")}
        onReopen={() => onStatus(null)}
        rejectLabel={t("avt.claimDetail.flagDispute")}
        reopenLabel={t("avt.review.undo")}
        state={state}
      />
      {state === "pending" && needsEvidenceControl && (
        <Button
          aria-pressed={needsEvidence}
          disabled={disabled}
          onClick={() => onStatus(needsEvidence ? null : "needs-evidence")}
          size="sm"
          variant={needsEvidence ? "secondary" : "ghost"}
        >
          <FileSearchIcon />
          {t(REVIEW_STATUS_META["needs-evidence"].labelKey)}
        </Button>
      )}
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
    // Open until the record answers it; the decision is still to make.
    case "needs-evidence": {
      return "pending";
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
  const status = review?.status ?? null;
  const decidedAtIso = review?.decidedAt ?? null;
  if (status === null || decidedAtIso === null) {
    return null;
  }
  const decidedAt = format.dateTime(
    Temporal.Instant.from(decidedAtIso).epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  return (
    <ReviewStatusBadge
      size="sm"
      tone={REVIEW_STATUS_META[status].tone}
      variant="solid"
    >
      {t("avt.review.decided", {
        status: REVIEW_STATUS_META[status].selectKey,
        origin: review?.statusOrigin ?? "single",
        decidedAt,
      })}
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
      // A quiet text action: full width is kept for a surface's one
      // primary action.
      <Button
        disabled={disabled}
        onClick={() => setDraft("")}
        size="sm"
        variant="ghost"
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
 * escalate = record conflict, gap = missing coverage to fill,
 * routine = neutral.
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
  gap: {
    tone: "neutral",
    textClass: "text-muted-foreground",
    icon: SearchIcon,
  },
  routine: {
    tone: "neutral",
    textClass: "text-muted-foreground",
    icon: CircleDashedIcon,
  },
};

type VerdictBasisProps = {
  claim: VerificationClaim;
  supportCount: number;
  conflictCount: number;
};

/** What the tool's verdict rests on, in words: how many facts support and
 *  conflict with it, or why there is no verdict to weigh. */
const VerdictBasis = ({
  claim,
  supportCount,
  conflictCount,
}: VerdictBasisProps) => {
  const t = useTranslations();
  const { state } = claim.verdict;
  switch (state) {
    // What missing coverage means is the verdict chip's tooltip; a gap says
    // what is missing in one line beside its next steps, and a silent
    // record's chip and caveat already say why nothing is added.
    case "nocover": {
      return null;
    }
    case "notverifiable": {
      return (
        <p className="text-muted-foreground bg-muted rounded-md p-3 text-sm leading-relaxed">
          {t.rich("avt.claimDetail.basis.notVerifiable", {
            strong: (chunks) => <b>{chunks}</b>,
          })}
        </p>
      );
    }
    case "recordconflict": {
      return (
        <p className="text-muted-foreground text-xs leading-relaxed">
          <b style={{ color: RECORD_CONFLICT_VAR }}>
            {t("avt.claimDetail.basis.verdictWithheld")}
          </b>
          <br />
          {t("avt.claimDetail.basis.anchorFactsDisagree")}
        </p>
      );
    }
    case "supported":
    case "tension":
    case "contradicted": {
      return (
        <div className="text-muted-foreground flex gap-3.5 text-xs tabular-nums">
          <span>
            {t("avt.claimDetail.basis.supportCount", { count: supportCount })}
          </span>
          <span>
            {t("avt.claimDetail.basis.conflictCount", {
              count: conflictCount,
            })}
          </span>
        </div>
      );
    }
    default: {
      state satisfies never;
      return panic(`Unhandled claim state: ${String(state)}`);
    }
  }
};

/** Where a fact card's actions act: the run it was pinned on and the list
 *  that owns the fact. */
type FactScope = { workspaceId: string; listId: string; runId: string };

type VerdictFactsProps = {
  scope: FactScope;
  claim: VerificationClaim;
  refs: readonly VerificationClaim["refs"][number][];
  cited: ReadonlyMap<FactId, ShownFact>;
  canReview: boolean;
};

/** The facts the verdict rests on. One the reviewer linked says so on its
 *  card, where it can be unlinked, rather than appearing a second time. */
const VerdictFacts = ({
  scope,
  claim,
  refs,
  cited,
  canReview,
}: VerdictFactsProps) => {
  const t = useTranslations();
  if (cited.size === 0) {
    return null;
  }
  const linked = new Set(claim.review?.linkedFactIds);
  return (
    <section className="space-y-2">
      <h3 className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
        {t("avt.claimDetail.whyVerdict")}
      </h3>
      {refs.map((ref) => {
        const fact = cited.get(ref.factEntityId);
        return fact === undefined ? null : (
          <FactCard
            fact={fact}
            key={ref.factEntityId}
            linkedMark={
              linked.has(ref.factEntityId) ? (
                <LinkedMark
                  {...scope}
                  claimId={claim.id}
                  disabled={!canReview}
                  factEntityId={ref.factEntityId}
                  factName={fact.text}
                />
              ) : null
            }
            rel={ref.rel}
            scope={scope}
          />
        );
      })}
    </section>
  );
};

const FactCard = ({
  scope,
  fact,
  rel,
  linkedMark = null,
}: {
  scope: FactScope;
  fact: ShownFact;
  rel: ClaimFactRelation;
  /** That the reviewer linked this fact, with its unlink action. */
  linkedMark?: React.ReactNode;
}) => {
  const t = useTranslations();
  const supports = rel === "supports";
  return (
    <article className="overflow-hidden rounded-lg border">
      <div className="bg-muted flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
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
        <div className="ms-auto flex flex-wrap items-center justify-end gap-1.5">
          {linkedMark}
          <ConfBadge level={fact.confidence} />
        </div>
      </div>
      <FactBody fact={fact} scope={scope} />
    </article>
  );
};

const FactBody = ({ scope, fact }: { scope: FactScope; fact: ShownFact }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const canUpdate = usePermissions({ entity: ["update"] });
  const legalListsEnabled = useCallerFeatureEnabled(CALLER_FEATURE.legalLists);
  const [addingSource, setAddingSource] = React.useState(false);
  const { workspaceId } = scope;
  const source = evidenceQuoteSource(fact.sources);
  const quote = source?.quote ?? null;
  return (
    <div className="space-y-2 px-3 py-2.5">
      <p className="text-sm leading-relaxed" dir="auto">
        {fact.text}
      </p>
      {/* The kind and medium describe the evidence itself (a calendar entry,
          an export page); set under the fact, they cannot read as a linked
          source, which only the footing line below names. */}
      {(fact.evidenceKind !== null || fact.medium !== null) && (
        <p className="text-muted-foreground text-xs" dir="auto">
          {[fact.evidenceKind, fact.medium]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
      )}
      <InterpNote note={fact.interpretationNote} />
      {quote !== null && (
        <p
          className="text-muted-foreground border-s-2 ps-2 text-xs italic"
          dir="auto"
        >
          {quote}
        </p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* The fact as it stands now, the footing the claim's qualifiers
            read. Only a linked
            document is a source, so a fact without one says so. */}
        {fact.standing.scoring === "held" && (
          <span className="text-foreground inline-flex items-center gap-1.5">
            <ReviewStatusDot tone="warning" />
            {t("avt.anchorFacts.heldForReview")}
          </span>
        )}
        <FactTierLabel
          onAddSource={
            canUpdate && legalListsEnabled ? () => setAddingSource(true) : null
          }
          tier={fact.standing.tier}
        />
        <EvidenceFactSource source={source} workspaceId={workspaceId} />
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
      {addingSource && (
        <ListSourceForm
          itemEntityId={fact.factEntityId}
          listId={scope.listId}
          onClose={() => setAddingSource(false)}
          onCreated={() => {
            // The fact's tier and the claim's qualifiers are read with the
            // run, so it is read again to show the new footing.
            detached(
              queryClient.invalidateQueries({
                queryKey: avtKeys.run(workspaceId, scope.runId),
              }),
              "claim-detail.refresh-run",
            );
          }}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
};

type RecordConflictBlockProps = {
  scope: FactScope;
  disabled: boolean;
  /** The record suggested to govern (a document's record over a person's
   *  account); null when neither is. */
  suggestedFactId: FactId | null;
  conflict: RecordConflict;
  review: ClaimReview | null;
  factsById: ReadonlyMap<FactId, ShownFact>;
  onResolve: (resolution: RecordConflictResolution, reason: string) => void;
};

type RecordConflictResolution = Extract<
  ClaimReviewEvent,
  { kind: "record-conflict" }
>["resolution"];

const RESOLUTION_REASON_LABEL_KEYS = {
  governed: "avt.reason.govern",
  escalated: "avt.reason.escalate",
} as const satisfies Record<
  NonNullable<RecordConflictResolution>["kind"],
  TranslationKey
>;

/** A resolution the reviewer picked and still has to give a reason for,
 *  asked beside the control it came from (a record, or the escalation). */
type PendingResolution = {
  control: FactId | "escalation";
  resolution: RecordConflictResolution;
};

const RecordConflictBlock = ({
  scope,
  suggestedFactId,
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
  const dateText = useFactDateText();
  // A date the grader gives as ISO reads in the locale's format; any other
  // value as written.
  const valueText = (value: string) => {
    const read = readConflictValue(value);
    return read.type === "date"
      ? dateText(read.occurredOn, read.precision)
      : read.text;
  };
  const [pending, setPending] = React.useState<PendingResolution | null>(null);
  const reasonFor = (control: PendingResolution["control"]) => {
    if (pending?.control !== control) {
      return null;
    }
    const next = pending.resolution;
    return (
      <ReasonField
        disabled={disabled}
        label={t(
          next === null
            ? "avt.reason.unresolveConflict"
            : RESOLUTION_REASON_LABEL_KEYS[next.kind],
        )}
        onCancel={() => setPending(null)}
        onSubmit={(reason) => {
          onResolve(next, reason);
          setPending(null);
        }}
        submitLabel={t("common.save")}
      />
    );
  };
  const records = conflict.factEntityIds.map((factEntityId, index) => ({
    factEntityId,
    value: valueText(conflict.values.at(index) ?? ""),
    fact: factsById.get(factEntityId),
  }));
  const governing = records.find(
    (record) => record.factEntityId === governingId,
  );
  // Until someone resolves the conflict, the suggested record is shown
  // selected; confirming it is still the reviewer's own action.
  const preselectedId = resolution === null ? suggestedFactId : null;
  const highlightedId = governingId ?? preselectedId;

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

      {preselectedId !== null && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("avt.claimDetail.recordConflict.suggestedNotice")}
        </p>
      )}

      <div className="space-y-2">
        {records.map((record) => (
          <div
            className={cn(
              "space-y-2 rounded-lg p-3",
              // The conflict's accent stays on its header; the chosen or
              // suggested record is marked by weight alone.
              highlightedId === record.factEntityId
                ? "border-primary border-2"
                : "border",
            )}
            key={record.factEntityId}
          >
            {/* Wraps rather than squeeze the value when the badges and
                the value do not fit on one line. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="min-w-0 text-sm font-semibold" dir="auto">
                {record.value}
              </h4>
              <div className="flex items-center gap-1.5">
                {preselectedId === record.factEntityId && (
                  <ReviewStatusBadge size="sm" tone="neutral">
                    {t("common.suggested")}
                  </ReviewStatusBadge>
                )}
                <ConfBadge level={record.fact?.confidence ?? null} />
              </div>
            </div>
            {record.fact !== undefined && (
              <FactBody fact={record.fact} scope={scope} />
            )}
            <Button
              disabled={disabled}
              onClick={() =>
                setPending({
                  control: record.factEntityId,
                  resolution:
                    governingId === record.factEntityId
                      ? null
                      : {
                          kind: "governed",
                          factEntityId: record.factEntityId,
                        },
                })
              }
              size="sm"
              variant={
                highlightedId === record.factEntityId ? "default" : "outline"
              }
            >
              <CheckIcon />
              {t(
                preselectedId === record.factEntityId
                  ? "avt.claimDetail.recordConflict.confirmGoverningRecord"
                  : "avt.claimDetail.recordConflict.treatAsGoverningRecord",
              )}
            </Button>
            {reasonFor(record.factEntityId)}
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
            setPending({
              control: "escalation",
              resolution:
                resolution?.kind === "escalated" ? null : { kind: "escalated" },
            })
          }
          variant={resolution?.kind === "escalated" ? "destructive" : "outline"}
        >
          <FlagIcon />
          {t("avt.claimDetail.recordConflict.flagForEvidenceTeam")}
        </Button>
        {reasonFor("escalation")}
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
