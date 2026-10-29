import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useFormatter, useTranslations } from "use-intl";

import { DESKTOP_BILLING_DRAFT_LIMITS } from "@stll/api-contract/desktop-billing-drafts";
import {
  DESKTOP_ACTIVITY_REVIEW_LIMIT,
  DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH,
} from "@stll/api-contract/desktop-time-entries";
import type {
  DesktopMatter,
  DesktopTimeEntryBatchResponse,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { CopyButton } from "@stll/ui/copy-button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { AiActionIcon, LockKeyholeIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { MatterIcon } from "@stll/ui/matter-icon";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { Textarea } from "@stll/ui/textarea";

import type { DesktopMessages } from "../i18n/index";
import { calendarDate, timedSegments } from "./activity-logic";
import type { ActivityDaySnapshot } from "./activity-types";
import { BillingClassificationCodes } from "./ActivityBillingDrafts";
import type { BillingDraftSettingsControl } from "./ActivityBillingDrafts";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { ActivityTimeline } from "./ActivityTimeline";
import type { TimelineSegment } from "./ActivityTimeline";
import {
  absorbedGroupIds,
  captureReviewSources,
  confirmedBatchItem,
  reviewItems,
  reviewSourcesCurrent,
} from "./billing-draft-logic";
import type {
  ConfirmedBatchItem,
  DraftableGroup,
  ReviewItem,
} from "./billing-draft-logic";
import { useBillingDraftSession } from "./billing-draft-session";
import type { DraftStatus, ReviewBarDrafts } from "./billing-draft-session";
import {
  initialReviewEdit,
  reviewReducer,
  reviewStateForGroups,
} from "./billing-review-state";
import type {
  EntryEdit,
  ReviewAction,
  ReviewEvent,
  ReviewState,
} from "./billing-review-state";
import "./day-review.css";
import { canAssign, matchDay } from "./day-review-logic";
import type {
  DayReviewGroup,
  MatchConfidence,
  MatchedSegment,
} from "./day-review-logic";
import { MatterPicker } from "./MatterPicker";

const CONFIDENCE_LABELS = {
  strong: "strongMatch",
  likely: "likelyMatch",
  manual: "manualMatch",
  unmatched: "notMatched",
} as const satisfies Record<MatchConfidence, keyof DesktopMessages["activity"]>;
const CONFIDENCE_TONES = {
  strong: "success",
  likely: "warning",
  manual: "success",
  unmatched: "neutral",
} as const satisfies Record<MatchConfidence, ReviewStatusTone>;

type CandidateState =
  | { type: "loading" }
  | { type: "failed" }
  | { type: "ready"; matters: DesktopTimeEntryMatterCandidate[] };
type Submission =
  | { type: "editing" }
  | { type: "submitting"; idempotencyKey: string; items: ConfirmedBatchItem[] }
  | { type: "retry"; idempotencyKey: string; items: ConfirmedBatchItem[] }
  | { type: "discarding"; idempotencyKey: string; items: ConfirmedBatchItem[] }
  | { type: "saved"; count: number };
export type ActivityReviewStatus = Submission["type"];
type Range = { startMs: number; endMs: number };

const PENDING_DISCARD_ACCESS = {
  available: true,
  pending: true,
  unreadable: true,
  unavailable: false,
  keyMissing: false,
  incompatible: false,
} as const satisfies Record<ActivityDaySnapshot["deletionStatus"], boolean>;

const canDiscardPending = (
  snapshot: ActivityDaySnapshot,
  submission: Submission,
): submission is Extract<Submission, { type: "retry" }> =>
  PENDING_DISCARD_ACCESS[snapshot.deletionStatus] &&
  !snapshot.timeBillingEnabled &&
  !snapshot.unreadable &&
  submission.type === "retry" &&
  snapshot.pendingBatch?.idempotencyKey === submission.idempotencyKey;

/** Each group's edits, defaulting to a narrative from what was recorded. */
type ReviewEditStore = {
  edits: ReviewState;
  sources: readonly DraftableGroup[];
};

const useReviewEdits = (groups: ReadonlyMap<string, DraftableGroup>) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const [stored, setReview] = useState<ReviewEditStore>(() => ({
    edits: new Map(),
    sources: captureReviewSources([...groups.values()]),
  }));
  const edits = reviewStateForGroups(stored.edits, groups);
  if (
    edits !== stored.edits ||
    stored.sources.length !== groups.size ||
    !reviewSourcesCurrent(stored.sources, groups)
  ) {
    setReview({ edits, sources: captureReviewSources([...groups.values()]) });
  }
  const narrative = (group: DayReviewGroup) =>
    group.evidence.length
      ? t("narrativeEvidence", {
          evidence: format.list(group.evidence, { type: "conjunction" }),
        })
      : t("narrativeApps", {
          apps: format.list(
            group.apps.map(({ name }) => name),
            { type: "conjunction" },
          ),
        });
  const initial = (group: DayReviewGroup) =>
    initialReviewEdit({
      type: "single",
      billable: true,
      narrative: narrative(group),
      classification: null,
    });
  const dispatch = (event: ReviewEvent) =>
    setReview((current) => {
      const latestGroups = new Map(
        current.sources.map((group) => [group.id, group]),
      );
      const action =
        event.type === "offer-results"
          ? ({
              type: "offer-results",
              groups: latestGroups,
              mode: event.mode,
              offers: event.offers.map((offer) => {
                const group = latestGroups.get(offer.groupId);
                return {
                  ...offer,
                  initial:
                    !current.edits.has(offer.groupId) && group
                      ? initial(group)
                      : offer.initial,
                };
              }),
            } as const satisfies ReviewAction)
          : event;
      const next = reviewReducer(current.edits, action);
      return next === current.edits
        ? current
        : { edits: next, sources: current.sources };
    });
  return {
    editFor: (group: DayReviewGroup) => edits.get(group.id) ?? initial(group),
    dispatch,
    notice: [...edits.values()].some(
      ({ content }) =>
        content.type === "single" && content.notice === "sourceChanged",
    )
      ? "sourceChanged"
      : null,
  };
};

const useMatterCandidates = (enabled: boolean) => {
  const [candidates, setCandidates] = useState<CandidateState>({
    type: "loading",
  });
  const candidateRequest = useRef(0);
  const refreshCandidates = useCallback(() => {
    const request = ++candidateRequest.current;
    invoke<DesktopTimeEntryMatterCandidate[]>("time_entry_candidates")
      .then((matters) => {
        if (request === candidateRequest.current) {
          setCandidates({ type: "ready", matters });
        }
        return undefined;
      })
      .catch(() => {
        if (request === candidateRequest.current) {
          setCandidates({ type: "failed" });
        }
      });
  }, []);
  useEffect(() => {
    if (enabled) {
      refreshCandidates();
    }
    return () => {
      candidateRequest.current += 1;
    };
  }, [refreshCandidates, enabled]);
  return { candidates, refreshCandidates };
};

type ReviewSubmissionOptions = {
  pendingBatch: ActivityDaySnapshot["pendingBatch"];
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
};

const useReviewSubmission = ({
  pendingBatch,
  onReviewStatusChange,
}: ReviewSubmissionOptions) => {
  const durablePendingKey = useRef(pendingBatch?.idempotencyKey ?? null);
  const [submission, setSubmission] = useState<Submission>(() => {
    const pending = pendingBatch;
    if (!pending) {
      return { type: "editing" };
    }
    return {
      type: "retry",
      idempotencyKey: pending.idempotencyKey,
      items: pending.entries.map((entry, index) => ({
        entry,
        ranges: pending.ranges.at(index) ?? [],
      })),
    };
  });
  const updateSubmission = (next: Submission) => {
    setSubmission(next);
    onReviewStatusChange(next.type);
  };
  useEffect(() => {
    if (pendingBatch !== null) {
      durablePendingKey.current = pendingBatch.idempotencyKey;
    }
    if (
      pendingBatch === null &&
      submission.type === "retry" &&
      durablePendingKey.current === submission.idempotencyKey
    ) {
      durablePendingKey.current = null;
      setSubmission({ type: "editing" });
      onReviewStatusChange("editing");
      return;
    }
    if (
      pendingBatch === null &&
      (submission.type === "editing" || submission.type === "saved")
    ) {
      durablePendingKey.current = null;
    }
    onReviewStatusChange(submission.type);
  }, [onReviewStatusChange, pendingBatch, submission]);
  return { submission, updateSubmission };
};

export const ActivityDayReview = ({
  snapshot,
  header,
  billingDrafts,
  onCopy,
  onReviewStatusChange,
}: {
  header: ReactNode;
  snapshot: ActivityDaySnapshot;
  billingDrafts: BillingDraftSettingsControl;
  onCopy: (text: string, onSettled: (copied: boolean) => void) => void;
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const { candidates, refreshCandidates } = useMatterCandidates(
    snapshot.timeBillingEnabled,
  );
  const { submission, updateSubmission } = useReviewSubmission({
    pendingBatch: snapshot.pendingBatch,
    onReviewStatusChange,
  });
  const [localDrafts, setLocalDrafts] = useState(snapshot.draftedEntries);
  const [errorMessage, setError] = useState<string | null>(null);
  const [leaveOut, setLeaveOut] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState<"closed" | "confirming">(
    "closed",
  );
  const sending = useRef(false);
  const matters = candidates.type === "ready" ? candidates.matters : [];
  const day = matchDay({
    segments: timedSegments(snapshot.segments),
    candidates: matters,
    captureDetails: snapshot.captureDetails,
    manualAssignments: snapshot.manualAssignments,
    draftedEntries: [...snapshot.draftedEntries, ...localDrafts],
  });
  const editable = submission.type === "editing" || submission.type === "saved";
  const eligible = day.groups.filter(
    (
      group,
    ): group is DayReviewGroup & { matter: DesktopTimeEntryMatterCandidate } =>
      group.matter !== null,
  );
  const currentGroups = new Map(eligible.map((group) => [group.id, group]));
  const { editFor, dispatch, notice } = useReviewEdits(currentGroups);
  const selected = eligible.filter((group) => editFor(group).selected);
  const rows = selected.map((group) => ({
    group,
    content: editFor(group).content,
  }));
  const items = reviewItems(rows, currentGroups);
  const absorbed = absorbedGroupIds(
    eligible.map((group) => ({ group, content: editFor(group).content })),
  );
  const selectionExceedsLimit = items.length > DESKTOP_ACTIVITY_REVIEW_LIMIT;
  const selectedTenths = selected.reduce(
    (sum, group) => sum + group.roundedTenths,
    0,
  );
  const session = useBillingDraftSession({
    snapshot,
    billingDrafts,
    eligible,
    selected,
    matters,
    editable,
    editFor,
    dispatch,
    onError: setError,
  });
  const hours = (value: number) =>
    format.number(value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const timelineSegments = withAwaySegments(day.segments, t("awayNotCounted"));
  const assignmentEnabled = canAssign({
    editable,
    timeBillingEnabled: snapshot.timeBillingEnabled,
  });
  const assign = (ranges: readonly Range[], matter: DesktopMatter) => {
    setError(null);
    // Only local instants and the chosen matter identity cross this native boundary.
    invoke("activity_assign_ranges", {
      date: snapshot.date,
      ranges: ranges.map(({ startMs, endMs }) => ({
        start: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
        end: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
        matterId: matter.id,
        matter: {
          id: matter.id,
          name: matter.name,
          reference: matter.reference,
          color: matter.color,
          clientName: null,
        },
      })),
    }).catch(() => setError(t("errorUpdate")));
  };
  const submit = () => {
    if (sending.current) {
      return;
    }
    if (submission.type !== "retry" && selectionExceedsLimit) {
      return;
    }
    const pending =
      submission.type === "retry"
        ? submission
        : {
            idempotencyKey: crypto.randomUUID(),
            items: items.map((item) =>
              confirmedBatchItem({
                item,
                date: snapshot.date,
                timezone: Temporal.Now.timeZoneId(),
              }),
            ),
          };
    if (pending.items.length === 0) {
      return;
    }
    sending.current = true;
    setError(null);
    updateSubmission({
      type: "submitting",
      idempotencyKey: pending.idempotencyKey,
      items: pending.items,
    });
    invoke<DesktopTimeEntryBatchResponse & { markerSaved: boolean }>(
      "time_entry_submit_batch_confirmed",
      {
        request: {
          date: snapshot.date,
          idempotencyKey: pending.idempotencyKey,
          items: pending.items,
        },
      },
    )
      .then(({ entries, markerSaved }) => {
        setLocalDrafts((current) => [
          ...current,
          ...pending.items.flatMap((item, index) => {
            const entry = entries.at(index);
            return entry
              ? item.ranges.map((range) => ({ ...range, entryId: entry.id }))
              : [];
          }),
        ]);
        if (markerSaved) {
          updateSubmission({ type: "saved", count: entries.length });
        } else {
          updateSubmission({
            type: "retry",
            idempotencyKey: pending.idempotencyKey,
            items: pending.items,
          });
          setError(t("draftMarkerFailed"));
        }
        return undefined;
      })
      .catch((error: unknown) => {
        const rejected =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "rejected";
        if (rejected && snapshot.pendingBatch === null) {
          updateSubmission({ type: "editing" });
        } else {
          updateSubmission({
            type: "retry",
            idempotencyKey: pending.idempotencyKey,
            items: pending.items,
          });
        }
        setError(t("batchFailed"));
      })
      .finally(() => {
        sending.current = false;
      });
  };
  const discardPending = () => {
    if (!canDiscardPending(snapshot, submission) || sending.current) {
      return;
    }
    const pending = submission;
    sending.current = true;
    setDiscardPrompt("closed");
    setError(null);
    updateSubmission({
      type: "discarding",
      idempotencyKey: pending.idempotencyKey,
      items: pending.items,
    });
    invoke("time_entry_discard_pending_batch_confirmed", {
      date: snapshot.date,
      idempotencyKey: pending.idempotencyKey,
    })
      .then(() => {
        updateSubmission({ type: "editing" });
        return undefined;
      })
      .catch(() => {
        updateSubmission({
          type: "retry",
          idempotencyKey: pending.idempotencyKey,
          items: pending.items,
        });
        setError(t("errorUpdate"));
      })
      .finally(() => {
        sending.current = false;
      });
  };
  return (
    <div className="flex flex-col gap-5">
      <DayReviewMetrics header={header} segments={day.segments} />
      <ActivityTimeline
        disabled={!assignmentEnabled}
        segments={timelineSegments}
        snapshot={snapshot}
        candidates={matters}
        onAssign={(range, matter) => assign([range], matter)}
      />
      {candidates.type === "failed" ? (
        <div
          role="alert"
          className="text-destructive flex items-center gap-2 text-sm"
        >
          {t("candidatesFailed")}
          <Button size="sm" variant="ghost" onClick={refreshCandidates}>
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {notice === null ? null : (
        <p role="status" className="text-muted-foreground text-xs">
          {t("aiStructureChanged")}
        </p>
      )}
      {session.steerBar}
      <ReviewEntries
        groups={day.groups}
        currentGroups={currentGroups}
        editFor={editFor}
        dispatch={dispatch}
        matters={matters}
        snapshot={snapshot}
        editable={editable}
        assignmentEnabled={assignmentEnabled}
        leaveOut={leaveOut}
        onLeaveOut={() => setLeaveOut(true)}
        assign={assign}
        absorbed={absorbed}
        draftReview={session.draftReview}
      />
      {session.guidelines}
      {session.consentDialog}
      <ReviewSubmissionFeedback
        snapshot={snapshot}
        submission={submission}
        errorMessage={errorMessage}
        selectionExceedsLimit={selectionExceedsLimit}
        discardPrompt={discardPrompt}
        onDiscardPromptChange={setDiscardPrompt}
        discardPending={discardPending}
      />
      <ReviewBar
        selected={selected}
        itemCount={items.length}
        eligibleCount={eligible.length}
        hours={hours(selectedTenths / 10)}
        snapshot={snapshot}
        submission={submission}
        drafts={session.bar}
        onCopy={async () =>
          // Resolves once the copy settles; a failed copy is reported by the
          // command runner and resolves false, leaving the button unconfirmed.
          new Promise<boolean>((resolve) => {
            onCopy(
              items
                .map(
                  (item) =>
                    `${item.matter.name} · ${format.dateTime(calendarDate(snapshot.date), { dateStyle: "medium" })} · ${t("hours", { hours: hours(item.durationMinutes / 60) })}: ${item.narrative}`,
                )
                .join("\n"),
              resolve,
            );
          })
        }
        onSubmit={submit}
        valid={
          !selectionExceedsLimit &&
          !session.busy &&
          items.every((item) => item.narrative.trim().length > 0)
        }
      />
    </div>
  );
};

type DayReviewMetricsProps = {
  header: ReactNode;
  segments: readonly MatchedSegment[];
};

const DayReviewMetrics = ({ header, segments }: DayReviewMetricsProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const hours = (value: number) =>
    format.number(value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const activeMs = segments.reduce(
    (sum, segment) => sum + segment.endMs - segment.startMs,
    0,
  );
  const matchedMs = segments.reduce(
    (sum, segment) =>
      sum + (segment.matter ? segment.endMs - segment.startMs : 0),
    0,
  );
  const draftedMs = segments.reduce(
    (sum, segment) =>
      sum + (segment.drafted ? segment.endMs - segment.startMs : 0),
    0,
  );
  return (
    <div className="flex flex-wrap items-center gap-5">
      {header}
      <div className="ms-auto flex flex-wrap gap-6 tabular-nums">
        {[
          { label: t("matchedToMatters"), ms: matchedMs, shown: true },
          // Active equals matched on a fully assigned day; show it only when
          // some time still needs a matter.
          {
            label: t("activeLabel"),
            ms: activeMs,
            shown: activeMs > matchedMs,
          },
          { label: t("draftedLabel"), ms: draftedMs, shown: draftedMs > 0 },
        ]
          .filter(({ shown }) => shown)
          .map(({ label, ms }) => (
            <div key={label}>
              <b className="block text-base font-semibold">
                {t("hours", { hours: hours(ms / 3_600_000) })}
              </b>
              <span className="text-muted-foreground text-xs">{label}</span>
            </div>
          ))}
      </div>
    </div>
  );
};

type ReviewSubmissionFeedbackProps = {
  snapshot: ActivityDaySnapshot;
  submission: Submission;
  errorMessage: string | null;
  selectionExceedsLimit: boolean;
  discardPrompt: "closed" | "confirming";
  onDiscardPromptChange: (prompt: "closed" | "confirming") => void;
  discardPending: () => void;
};

const ReviewSubmissionFeedback = ({
  snapshot,
  submission,
  errorMessage,
  selectionExceedsLimit,
  discardPrompt,
  onDiscardPromptChange,
  discardPending,
}: ReviewSubmissionFeedbackProps) => {
  const t = useTranslations("activity");
  return (
    <>
      {errorMessage ? (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage}
        </p>
      ) : null}
      {!snapshot.timeBillingEnabled && submission.type === "retry" ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("batchUnavailable")}
        </p>
      ) : null}
      {canDiscardPending(snapshot, submission) ? (
        <div>
          <Button
            variant="outline"
            onClick={() => onDiscardPromptChange("confirming")}
          >
            {t("discardPendingRecovery")}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={
          discardPrompt === "confirming" &&
          snapshot.deletionStatus !== "incompatible"
        }
        onOpenChange={(open) =>
          onDiscardPromptChange(open ? "confirming" : "closed")
        }
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("discardPendingRecovery")}</DialogTitle>
            <DialogDescription>
              {t("discardPendingConfirmation")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("cancel")}
            </DialogClose>
            <Button
              variant="destructive"
              disabled={!canDiscardPending(snapshot, submission)}
              onClick={discardPending}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {(submission.type === "editing" || submission.type === "saved") &&
      selectionExceedsLimit ? (
        <p role="alert" className="text-destructive text-sm">
          {t("batchLimitExceeded", { limit: DESKTOP_ACTIVITY_REVIEW_LIMIT })}
        </p>
      ) : null}
      {submission.type === "saved" ? (
        <p role="status" className="text-sm">
          {t("batchCreated", { count: submission.count })}
        </p>
      ) : null}
    </>
  );
};

const withAwaySegments = (
  segments: readonly MatchedSegment[],
  awayLabel: string,
) => {
  const timelineSegments: TimelineSegment[] = [];
  for (const segment of segments) {
    const previous = timelineSegments.at(-1);
    if (previous && segment.startMs > previous.endMs) {
      timelineSegments.push({
        type: "idle",
        startMs: previous.endMs,
        endMs: segment.startMs,
        appIdentifier: "",
        appName: awayLabel,
        matterId: null,
        document: null,
        windowTitle: null,
        call: false,
        matter: null,
        confidence: "unmatched",
        evidence: [],
        drafted: false,
      });
    }
    timelineSegments.push({ ...segment, type: "active" });
  }
  return timelineSegments;
};

const DRAFT_BUTTON_LABELS = {
  draft: "aiDraft",
  drafting: "aiDrafting",
  drafted: "aiDrafted",
  tooMany: "aiDraft",
} as const satisfies Record<DraftStatus, keyof DesktopMessages["activity"]>;

const ReviewBar = ({
  selected,
  itemCount,
  eligibleCount,
  hours,
  snapshot,
  submission,
  drafts,
  onCopy,
  onSubmit,
  valid,
}: {
  selected: readonly DayReviewGroup[];
  itemCount: number;
  eligibleCount: number;
  hours: string;
  snapshot: ActivityDaySnapshot;
  submission: Submission;
  drafts: ReviewBarDrafts | null;
  onCopy: () => Promise<boolean>;
  onSubmit: () => void;
  valid: boolean;
}) => {
  const t = useTranslations("activity");
  const draftEditable =
    submission.type === "editing" || submission.type === "saved";
  const disabled =
    !snapshot.timeBillingEnabled ||
    submission.type === "submitting" ||
    submission.type === "discarding" ||
    (submission.type !== "retry" && (selected.length === 0 || !valid));
  return (
    <footer className="bg-card sticky bottom-0 z-10 -mx-6 flex flex-col gap-2 border-t px-6 py-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="tabular-nums">
          {t("selectedSummary", {
            selected: selected.length,
            total: eligibleCount,
            hours,
          })}{" "}
          · {t("roundedSixMinutes")}
        </span>
        <span className="ms-auto flex items-center gap-1">
          <LockKeyholeIcon aria-hidden="true" className="size-3" />
          {t("batchPrivacy")}
        </span>
      </div>
      {/* The actions get their own row so creating drafts never wraps away. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <CopyButton
          copiedLabel={t("copied")}
          disabled={selected.length === 0}
          iconClassName="size-4"
          label={t("copySummary")}
          onCopy={onCopy}
          size="sm"
          variant="outline"
        />
        {drafts?.undoable ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!draftEditable}
            onClick={drafts.onUndoAll}
          >
            {t("aiUndoAll")}
          </Button>
        ) : null}
        {drafts ? (
          <Button
            size="sm"
            variant="outline"
            title={
              drafts.status === "tooMany"
                ? t("aiDraftLimit", {
                    limit: DESKTOP_BILLING_DRAFT_LIMITS.entries,
                  })
                : undefined
            }
            disabled={!draftEditable || drafts.status !== "draft"}
            onClick={drafts.onDraft}
          >
            <AiActionIcon aria-hidden="true" />
            {t(DRAFT_BUTTON_LABELS[drafts.status])}
          </Button>
        ) : null}
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {submission.type === "retry"
            ? t("pendingRetry")
            : t("createDrafts", { count: itemCount })}
        </Button>
      </div>
    </footer>
  );
};

export const ActivityMatterHeading = ({
  matter,
}: {
  matter: DesktopMatter;
}) => (
  <>
    <MatterIcon matter={matter} className="size-4 shrink-0" />
    <bdi id={`review-matter-${matter.id}`}>{matter.name}</bdi>
    {matter.reference ? (
      <span className="text-muted-foreground text-xs font-normal">
        {matter.reference}
      </span>
    ) : null}
  </>
);

type ReviewItemFieldsProps = {
  item: ReviewItem;
  structured: boolean;
  editable: boolean;
  onNarrative: (narrative: string) => void;
  onBillable: (billable: boolean) => void;
};

const ReviewItemFields = ({
  item,
  structured,
  editable,
  onNarrative,
  onBillable,
}: ReviewItemFieldsProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  return (
    <div className="mt-2" id={`review-item-${item.key}`}>
      {structured ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <MatterIcon matter={item.matter} className="size-3" />
          <bdi>{item.matter.name}</bdi>
          {t("hours", {
            hours: format.number(item.durationMinutes / 60, {
              maximumFractionDigits: 1,
            }),
          })}
        </p>
      ) : null}
      {item.classification !== null ? (
        <div className="flex items-center justify-end">
          <BillingClassificationCodes classification={item.classification} />
        </div>
      ) : null}
      <Textarea
        className="hover:border-input focus-visible:border-ring min-h-9 resize-none border-transparent bg-transparent px-2 py-1.5 text-sm"
        rows={1}
        aria-label={t("entryNarrative")}
        aria-describedby={`review-item-${item.key}`}
        value={item.narrative}
        maxLength={DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH}
        disabled={!editable}
        onChange={(event) => onNarrative(event.target.value)}
      />
      <Label className="text-muted-foreground gap-1.5 text-xs">
        <Button
          role="switch"
          aria-label={t("entryBillable")}
          aria-describedby={`review-item-${item.key}`}
          aria-checked={item.billable}
          disabled={!editable}
          size="icon-xs"
          variant="ghost"
          className={`h-4 w-7 rounded-full border-0 ${item.billable ? "bg-primary" : "bg-input"}`}
          onClick={() => onBillable(!item.billable)}
        >
          <span
            aria-hidden="true"
            className={`bg-primary-foreground absolute start-0.5 size-3 rounded-full transition-transform motion-reduce:transition-none ${item.billable ? "translate-x-2.5 rtl:-translate-x-2.5" : ""}`}
          />
        </Button>
        {t("entryBillable")}
      </Label>
    </div>
  );
};

const ReviewEntries = ({
  groups,
  currentGroups,
  editFor,
  dispatch,
  matters,
  snapshot,
  editable,
  assignmentEnabled,
  leaveOut,
  onLeaveOut,
  assign,
  absorbed,
  draftReview,
}: {
  groups: readonly DayReviewGroup[];
  currentGroups: ReadonlyMap<string, DraftableGroup>;
  editFor: (group: DayReviewGroup) => EntryEdit;
  dispatch: (action: ReviewAction) => void;
  matters: readonly DesktopTimeEntryMatterCandidate[];
  snapshot: ActivityDaySnapshot;
  editable: boolean;
  assignmentEnabled: boolean;
  leaveOut: boolean;
  onLeaveOut: () => void;
  assign: (ranges: readonly Range[], matter: DesktopMatter) => void;
  absorbed: ReadonlySet<string>;
  draftReview: (
    group: DayReviewGroup & { matter: DesktopTimeEntryMatterCandidate },
  ) => ReactNode;
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const hours = (value: number) =>
    format.number(value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">
          {snapshot.date === snapshot.today ? t("reviewToday") : t("reviewDay")}
        </h2>
      </div>
      <div className="divide-y overflow-clip rounded-xl border">
        {groups.map((group) => {
          const edit = editFor(group);
          const matter = group.matter;
          if (!matter) {
            return leaveOut ? null : (
              <div key="unmatched" className="bg-muted px-4 py-3.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <MatterIcon variant="none" className="size-4" />
                  {t("notMatched")} ·{" "}
                  {t("hours", { hours: hours(group.roundedTenths / 10) })}
                </div>
                <Evidence group={group} snapshot={snapshot} />
                <div className="mt-2 flex flex-wrap gap-2">
                  {matters
                    .filter(
                      ({ signals }) =>
                        signals.lastWorkedAt || signals.newlyAssignedAt,
                    )
                    .slice(0, 3)
                    .map((candidate) => (
                      <Button
                        key={candidate.id}
                        variant="outline"
                        size="sm"
                        disabled={!assignmentEnabled}
                        onClick={() =>
                          assign(
                            group.ranges.map(({ start, end }) => ({
                              startMs:
                                Temporal.Instant.from(start).epochMilliseconds,
                              endMs:
                                Temporal.Instant.from(end).epochMilliseconds,
                            })),
                            candidate,
                          )
                        }
                      >
                        <MatterIcon matter={candidate} className="size-3" />
                        <bdi>{candidate.name}</bdi>
                        <span className="text-muted-foreground text-2xs">
                          {candidate.signals.newlyAssignedAt
                            ? t("newAssignment")
                            : t("workedRecently")}
                        </span>
                      </Button>
                    ))}
                  <MatterPicker
                    disabled={!assignmentEnabled}
                    candidates={matters}
                    onChoose={(chosen) =>
                      assign(
                        group.ranges.map(({ start, end }) => ({
                          startMs:
                            Temporal.Instant.from(start).epochMilliseconds,
                          endMs: Temporal.Instant.from(end).epochMilliseconds,
                        })),
                        chosen,
                      )
                    }
                    label={t("otherMatter")}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onLeaveOut()}
                  >
                    {t("leaveOut")}
                  </Button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={matter.id}
              className={`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 px-4 py-3.5 min-[40rem]:grid-cols-[1.25rem_minmax(0,1fr)_auto] ${!edit.selected ? "opacity-55" : ""}`}
            >
              <Checkbox
                className="mt-0.5"
                aria-label={t("includeMatter", { matter: matter.name })}
                checked={edit.selected}
                disabled={!editable}
                onCheckedChange={(selected) =>
                  dispatch({
                    type: "set-selected",
                    groupId: group.id,
                    initial: edit,
                    selected,
                  })
                }
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <ActivityMatterHeading matter={matter} />
                  {matter.signals.upcomingDeadline ? (
                    <ReviewStatusBadge tone="neutral">
                      {t("upcomingDeadline")} ·{" "}
                      {format.dateTime(
                        calendarDate(
                          matter.signals.upcomingDeadline.slice(0, 10),
                        ),
                        { dateStyle: "short" },
                      )}
                    </ReviewStatusBadge>
                  ) : null}
                  {matter.signals.newlyAssignedAt ? (
                    <ReviewStatusBadge tone="neutral">
                      {t("newAssignment")}
                    </ReviewStatusBadge>
                  ) : null}
                  {group.confidence === "likely" ? (
                    <ReviewStatusBadge
                      tone={CONFIDENCE_TONES[group.confidence]}
                    >
                      {t(CONFIDENCE_LABELS[group.confidence])}
                    </ReviewStatusBadge>
                  ) : null}
                </div>
                <Evidence group={group} snapshot={snapshot} compact />
                {absorbed.has(group.id) ? (
                  <p className="text-muted-foreground mt-2 px-2 text-xs">
                    {t("aiMergedIntoAnother")}
                  </p>
                ) : (
                  <>
                    {reviewItems(
                      [{ group: { ...group, matter }, content: edit.content }],
                      currentGroups,
                    ).map((item) => (
                      <ReviewItemFields
                        key={item.key}
                        item={item}
                        structured={edit.content.type === "accepted"}
                        editable={editable}
                        onNarrative={(narrative) =>
                          dispatch({
                            type: "set-narrative",
                            groupId: group.id,
                            initial: edit,
                            itemKey: item.key,
                            narrative,
                          })
                        }
                        onBillable={(billable) =>
                          dispatch({
                            type: "set-billable",
                            groupId: group.id,
                            initial: edit,
                            itemKey: item.key,
                            billable,
                          })
                        }
                      />
                    ))}
                    {draftReview({ ...group, matter })}
                  </>
                )}
              </div>
              <div className="col-start-2 flex items-center justify-between gap-2 min-[40rem]:col-start-3 min-[40rem]:flex-col min-[40rem]:items-end">
                <div className="text-base font-semibold tabular-nums">
                  {t("hours", { hours: hours(group.roundedTenths / 10) })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const Evidence = ({
  group,
  snapshot,
  compact = false,
}: {
  group: DayReviewGroup;
  snapshot: ActivityDaySnapshot;
  /** Icons only; the narrative below already names the work. */
  compact?: boolean;
}) => (
  <div
    className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs"
    title={
      compact
        ? group.evidence.join(" · ") ||
          group.apps.map(({ name }) => name).join(" · ")
        : undefined
    }
  >
    {group.apps.map(({ identifier }) => (
      <ActivitySourceIcon
        key={identifier}
        appIdentifier={identifier}
        sourceAppVisuals={snapshot.sourceAppVisuals}
      />
    ))}
    <bdi className={compact ? "sr-only" : "min-w-0 wrap-break-word"}>
      {group.evidence.join(" · ") ||
        group.apps.map(({ name }) => name).join(" · ")}
    </bdi>
  </div>
);
