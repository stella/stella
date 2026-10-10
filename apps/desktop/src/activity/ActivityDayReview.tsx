import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useFormatter, useTranslations } from "use-intl";

import type {
  DesktopMatter,
  DesktopTimeEntryBatch,
  DesktopTimeEntryBatchResponse,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { CopyIcon, LockKeyholeIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { MatterIcon } from "@stll/ui/matter-icon";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { Textarea } from "@stll/ui/textarea";

import type { DesktopMessages } from "../i18n/index";
import { calendarDate, timedSegments } from "./activity-logic";
import type { ActivityDaySnapshot } from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { ActivityTimeline } from "./ActivityTimeline";
import type { TimelineSegment } from "./ActivityTimeline";
import "./day-review.css";
import { matchDay } from "./day-review-logic";
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
type EntryEdit = { selected: boolean; billable: boolean; narrative: string };
type BatchItem = {
  entry: DesktopTimeEntryBatch["entries"][number];
  ranges: { start: string; end: string }[];
};
type Submission =
  | { type: "editing" }
  | { type: "submitting"; idempotencyKey: string; items: BatchItem[] }
  | { type: "retry"; idempotencyKey: string; items: BatchItem[] }
  | { type: "saved"; count: number; markerSaved: boolean };
type Range = { startMs: number; endMs: number };

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

export const ActivityDayReview = ({
  snapshot,
  header,
  onCopy,
}: {
  header: ReactNode;
  snapshot: ActivityDaySnapshot;
  onCopy: (text: string, onSuccess: () => void) => void;
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const { candidates, refreshCandidates } = useMatterCandidates(
    snapshot.timeBillingEnabled,
  );
  const [edits, setEdits] = useState<Record<string, EntryEdit>>({});
  const [submission, setSubmission] = useState<Submission>(() => {
    const pending = snapshot.pendingBatch;
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
  const [localDrafts, setLocalDrafts] = useState(snapshot.draftedEntries);
  const [errorMessage, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [leaveOut, setLeaveOut] = useState(false);
  const sending = useRef(false);
  const matters = candidates.type === "ready" ? candidates.matters : [];
  const day = matchDay({
    segments: timedSegments(snapshot.segments),
    candidates: matters,
    captureDetails: snapshot.captureDetails,
    manualAssignments: snapshot.manualAssignments,
    draftedEntries: [...snapshot.draftedEntries, ...localDrafts],
  });
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
  const editFor = (group: DayReviewGroup) =>
    edits[group.matter?.id ?? "unmatched"] ?? {
      selected: true,
      billable: true,
      narrative: narrative(group),
    };
  const editable =
    submission.type === "editing" ||
    (submission.type === "saved" && submission.markerSaved);
  const update = (group: DayReviewGroup, change: Partial<EntryEdit>) => {
    setEdits({
      ...edits,
      [group.matter?.id ?? "unmatched"]: { ...editFor(group), ...change },
    });
    setCopied(false);
  };
  const eligible = day.groups.filter(
    (
      group,
    ): group is DayReviewGroup & { matter: DesktopTimeEntryMatterCandidate } =>
      group.matter !== null,
  );
  const selected = eligible.filter((group) => editFor(group).selected);
  const selectedTenths = selected.reduce(
    (sum, group) => sum + group.roundedTenths,
    0,
  );
  const hours = (value: number) =>
    format.number(value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const activeMs = day.segments.reduce(
    (sum, segment) => sum + segment.endMs - segment.startMs,
    0,
  );
  const matchedMs = day.segments.reduce(
    (sum, segment) =>
      sum + (segment.matter ? segment.endMs - segment.startMs : 0),
    0,
  );
  const draftedMs = day.segments.reduce(
    (sum, segment) =>
      sum + (segment.drafted ? segment.endMs - segment.startMs : 0),
    0,
  );
  const timelineSegments = withAwaySegments(day.segments, t("awayNotCounted"));
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
    if (submission.type === "saved" && !submission.markerSaved) {
      return;
    }
    const pending =
      submission.type === "retry"
        ? submission
        : {
            idempotencyKey: crypto.randomUUID(),
            items: selected.map((group) => ({
              entry: {
                matterId: group.matter.id,
                dateWorked: snapshot.date,
                timezoneId: Temporal.Now.timeZoneId(),
                durationMinutes: group.roundedTenths * 6,
                narrative: editFor(group).narrative,
                billable: editFor(group).billable,
              },
              ranges: group.ranges,
            })),
          };
    if (pending.items.length === 0) {
      return;
    }
    sending.current = true;
    setError(null);
    setSubmission({
      type: "submitting",
      idempotencyKey: pending.idempotencyKey,
      items: pending.items,
    });
    invoke<DesktopTimeEntryBatchResponse & { markerSaved: boolean }>(
      "time_entry_submit_batch_confirmed",
      {
        date: snapshot.date,
        idempotencyKey: pending.idempotencyKey,
        items: pending.items,
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
        setSubmission({ type: "saved", count: entries.length, markerSaved });
        return undefined;
      })
      .catch((error: unknown) => {
        const rejected =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "rejected";
        if (rejected) {
          setSubmission({ type: "editing" });
        } else {
          setSubmission({
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
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-5">
        {header}
        <div className="ms-auto flex flex-wrap gap-6 tabular-nums">
          {[
            { label: t("activeLabel"), ms: activeMs },
            { label: t("matchedToMatters"), ms: matchedMs },
            { label: t("draftedLabel"), ms: draftedMs },
          ].map(({ label, ms }) => (
            <div key={label}>
              <b className="block text-base font-semibold">
                {t("hours", { hours: hours(ms / 3_600_000) })}
              </b>
              <span className="text-muted-foreground text-xs">{label}</span>
            </div>
          ))}
        </div>
      </div>
      <ActivityTimeline
        disabled={!editable || !snapshot.timeBillingEnabled}
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
      <ReviewEntries
        groups={day.groups}
        editFor={editFor}
        update={update}
        matters={matters}
        snapshot={snapshot}
        editable={editable}
        leaveOut={leaveOut}
        onLeaveOut={() => setLeaveOut(true)}
        assign={assign}
      />
      {errorMessage ? (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage}
        </p>
      ) : null}
      {submission.type === "saved" ? (
        <p
          role={submission.markerSaved ? "status" : "alert"}
          className="text-sm"
        >
          {submission.markerSaved
            ? t("batchCreated", { count: submission.count })
            : t("draftMarkerFailed")}
        </p>
      ) : null}
      <ReviewBar
        selected={selected}
        eligibleCount={eligible.length}
        hours={hours(selectedTenths / 10)}
        snapshot={snapshot}
        submission={submission}
        copied={copied}
        onCopy={() =>
          onCopy(
            selected
              .map(
                (group) =>
                  `${group.matter.name} · ${format.dateTime(calendarDate(snapshot.date), { dateStyle: "medium" })} · ${t("hours", { hours: hours(group.roundedTenths / 10) })}: ${editFor(group).narrative}`,
              )
              .join("\n"),
            () => setCopied(true),
          )
        }
        onSubmit={submit}
        valid={selected.every(
          (group) => editFor(group).narrative.trim().length > 0,
        )}
      />
    </div>
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

const ReviewBar = ({
  selected,
  eligibleCount,
  hours,
  snapshot,
  submission,
  copied,
  onCopy,
  onSubmit,
  valid,
}: {
  selected: readonly DayReviewGroup[];
  eligibleCount: number;
  hours: string;
  snapshot: ActivityDaySnapshot;
  submission: Submission;
  copied: boolean;
  onCopy: () => void;
  onSubmit: () => void;
  valid: boolean;
}) => {
  const t = useTranslations("activity");
  const disabled =
    !snapshot.timeBillingEnabled ||
    submission.type === "submitting" ||
    (submission.type === "saved" && !submission.markerSaved) ||
    (submission.type !== "retry" && (selected.length === 0 || !valid));
  return (
    <footer className="bg-card sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center gap-3 border-t px-6 py-3">
      <span className="text-muted-foreground text-xs tabular-nums">
        {t("selectedSummary", {
          selected: selected.length,
          total: eligibleCount,
          hours,
        })}
      </span>
      <span className="text-muted-foreground ms-auto flex items-center gap-1 text-xs">
        <LockKeyholeIcon aria-hidden="true" className="size-3" />
        {t("batchPrivacy")}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={selected.length === 0}
        onClick={onCopy}
      >
        <CopyIcon aria-hidden="true" />
        {copied ? t("copied") : t("copySummary")}
      </Button>
      <Button size="sm" disabled={disabled} onClick={onSubmit}>
        {submission.type === "retry"
          ? t("pendingRetry")
          : t("createDrafts", { count: selected.length })}
      </Button>
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

const ReviewEntries = ({
  groups,
  editFor,
  update,
  matters,
  snapshot,
  editable,
  leaveOut,
  onLeaveOut,
  assign,
}: {
  groups: readonly DayReviewGroup[];
  editFor: (group: DayReviewGroup) => EntryEdit;
  update: (group: DayReviewGroup, change: Partial<EntryEdit>) => void;
  matters: readonly DesktopTimeEntryMatterCandidate[];
  snapshot: ActivityDaySnapshot;
  editable: boolean;
  leaveOut: boolean;
  onLeaveOut: () => void;
  assign: (ranges: readonly Range[], matter: DesktopMatter) => void;
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
        <p className="text-muted-foreground text-xs">
          {t("reviewDescription")}
        </p>
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
                        disabled={!editable}
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
                    disabled={!editable || !snapshot.timeBillingEnabled}
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
              className={`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 px-4 py-3.5 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] ${!edit.selected ? "opacity-55" : ""}`}
            >
              <Checkbox
                className="mt-0.5"
                aria-label={t("includeMatter", { matter: matter.name })}
                checked={edit.selected}
                disabled={!editable}
                onCheckedChange={(value) => update(group, { selected: value })}
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
                  {
                    <ReviewStatusBadge
                      tone={CONFIDENCE_TONES[group.confidence]}
                    >
                      {t(CONFIDENCE_LABELS[group.confidence])}
                    </ReviewStatusBadge>
                  }
                </div>
                <Evidence group={group} snapshot={snapshot} />
                <Textarea
                  className="hover:border-input focus-visible:border-ring mt-2 min-h-9 resize-none border-transparent bg-transparent px-2 py-1.5 text-sm"
                  rows={1}
                  aria-label={t("entryNarrative")}
                  aria-describedby={`review-matter-${matter.id}`}
                  value={edit.narrative}
                  maxLength={4000}
                  disabled={!editable}
                  onChange={(event) =>
                    update(group, { narrative: event.target.value })
                  }
                />
              </div>
              <div className="col-start-2 flex items-center justify-between gap-2 sm:col-start-3 sm:flex-col sm:items-end">
                <div className="text-base font-semibold tabular-nums">
                  {t("hours", { hours: hours(group.roundedTenths / 10) })}
                  <span className="text-muted-foreground text-2xs block font-normal">
                    {t("roundedSixMinutes")}
                  </span>
                </div>
                <Label className="text-muted-foreground gap-1.5 text-xs">
                  <Button
                    role="switch"
                    aria-label={t("entryBillable")}
                    aria-describedby={`review-matter-${matter.id}`}
                    aria-checked={edit.billable}
                    disabled={!editable}
                    size="icon-xs"
                    variant="ghost"
                    className={`h-4 w-7 rounded-full border-0 ${edit.billable ? "bg-primary" : "bg-input"}`}
                    onClick={() => update(group, { billable: !edit.billable })}
                  >
                    <span
                      aria-hidden="true"
                      className={`bg-primary-foreground absolute start-0.5 size-3 rounded-full transition-transform motion-reduce:transition-none ${edit.billable ? "translate-x-2.5 rtl:-translate-x-2.5" : ""}`}
                    />
                  </Button>
                  {t("entryBillable")}
                </Label>
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
}: {
  group: DayReviewGroup;
  snapshot: ActivityDaySnapshot;
}) => (
  <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs">
    {group.apps.map(({ identifier }) => (
      <ActivitySourceIcon
        key={identifier}
        appIdentifier={identifier}
        sourceAppVisuals={snapshot.sourceAppVisuals}
      />
    ))}
    <bdi className="min-w-0 wrap-break-word">
      {group.evidence.join(" · ") ||
        group.apps.map(({ name }) => name).join(" · ")}
    </bdi>
  </div>
);
