import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_SEVERITY,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type {
  OpenWorkObligationStatus,
  SignalSeverity,
} from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";
import { DAY_IN_MS } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import type { NewSignal } from "@/api/lib/signals/emit";

/** An owner who has not answered an assignment for this long is stuck. */
export const WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS = 3;
/** A hard deadline this close, or already past, is at risk. */
export const WORK_ATTENTION_DEADLINE_DAYS = 3;

/** Titles are stored in a 512-char column; entity names are not bounded that low. */
const WORK_ATTENTION_NAME_MAX_CHARS = 200;

/**
 * The slice of a governed obligation the scout reasons about.
 *
 * `assignedAt` is the occurrence of the latest `owner_assigned` or `delegated`
 * event, not `updated_at`: any date, provenance or type edit moves
 * `updated_at`, which would silently restart the acknowledgement clock on work
 * nobody has answered for. Obligations created already-owned (the legacy
 * backfill) carry no assignment event, so the caller falls back to `createdAt`,
 * which is the same instant the owner was put on the row.
 */
export type WorkAttentionObligation = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  name: string;
  status: OpenWorkObligationStatus;
  ownerUserId: SafeId<"user">;
  assignedAt: Date;
  workingTargetDate: string | null;
  hardDeadlineDate: string | null;
};

/**
 * Civil date of an instant on the server's UTC day. `hard_deadline_date` is a
 * date with no time zone, and the My Work queues default their `asOf` to the
 * same UTC day, so the scout and the queue agree about what is due.
 */
export const workAttentionToday = (now: Date): string =>
  now.toISOString().slice(0, 10);

const dateOnlyMs = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getTime();

/** Whole days between two civil dates; negative once `date` is in the past. */
export const daysUntilDate = (date: string, now: Date): number =>
  (dateOnlyMs(date) - dateOnlyMs(workAttentionToday(now))) / DAY_IN_MS;

/** Whole days an assignment has gone unanswered; partial days do not count. */
export const daysWaitingSince = (assignedAt: Date, now: Date): number =>
  Math.floor((now.getTime() - assignedAt.getTime()) / DAY_IN_MS);

/** Past due is a missed obligation, not a warning about one. */
export const deadlineAtRiskSeverity = (
  daysUntilDeadline: number,
): SignalSeverity =>
  daysUntilDeadline < 0 ? SIGNAL_SEVERITY.CRITICAL : SIGNAL_SEVERITY.WARNING;

/**
 * One key per obligation and assignment. Holding the assignment instant keeps
 * a still-unanswered obligation from re-emitting every hour, while a
 * reassignment starts a new observation instead of being deduplicated into the
 * previous owner's signal.
 */
export const unacknowledgedDedupeKey = (
  entityId: SafeId<"entity">,
  assignedAt: Date,
): string =>
  `work-attention:v1:unacknowledged:${entityId}:${assignedAt.toISOString()}`;

/** One key per obligation and deadline, so a moved deadline is a new risk. */
export const deadlineAtRiskDedupeKey = (
  entityId: SafeId<"entity">,
  hardDeadlineDate: string,
): string => `work-attention:v1:deadline:${entityId}:${hardDeadlineDate}`;

const capName = (name: string): string =>
  name.length <= WORK_ATTENTION_NAME_MAX_CHARS
    ? name
    : `${name.slice(0, WORK_ATTENTION_NAME_MAX_CHARS)}…`;

const unacknowledgedSignal = (
  obligation: WorkAttentionObligation,
  daysWaiting: number,
): NewSignal => {
  const name = capName(obligation.name);
  return {
    kind: SIGNAL_KIND.WORK_UNACKNOWLEDGED,
    scoutKey: SCOUT_KEY.WORK_ATTENTION,
    workspaceId: obligation.workspaceId,
    severity: SIGNAL_SEVERITY.WARNING,
    confidence: null,
    title: `Unacknowledged for ${daysWaiting} days: ${name}`,
    summary: `${name} has been awaiting acknowledgement since ${obligation.assignedAt.toISOString()}.`,
    subject: {
      type: "entity",
      workspaceId: obligation.workspaceId,
      entityId: obligation.entityId,
    },
    evidence: {
      kind: SIGNAL_KIND.WORK_UNACKNOWLEDGED,
      obligationEntityId: obligation.entityId,
      ownerUserId: obligation.ownerUserId,
      assignedAt: obligation.assignedAt.toISOString(),
      daysWaiting,
      workingTargetDate: obligation.workingTargetDate,
      hardDeadlineDate: obligation.hardDeadlineDate,
    },
    // Routing the signal to whoever should chase the owner is the only
    // suggestion that fits: the task and deadline this reports on already
    // exist, so every creating suggestion would duplicate them.
    suggestions: [{ kind: SUGGESTION_KIND.ASSIGN }],
    dedupeKey: unacknowledgedDedupeKey(
      obligation.entityId,
      obligation.assignedAt,
    ),
  };
};

const deadlineAtRiskSignal = (
  obligation: WorkAttentionObligation,
  hardDeadlineDate: string,
  daysUntilDeadline: number,
): NewSignal => {
  const name = capName(obligation.name);
  const overdue = daysUntilDeadline < 0;
  return {
    kind: SIGNAL_KIND.WORK_DEADLINE_AT_RISK,
    scoutKey: SCOUT_KEY.WORK_ATTENTION,
    workspaceId: obligation.workspaceId,
    severity: deadlineAtRiskSeverity(daysUntilDeadline),
    confidence: null,
    title: overdue
      ? `Hard deadline passed: ${name}`
      : `Hard deadline in ${daysUntilDeadline} days: ${name}`,
    summary: `${name} has a hard deadline on ${hardDeadlineDate} and is still ${obligation.status}.`,
    subject: {
      type: "entity",
      workspaceId: obligation.workspaceId,
      entityId: obligation.entityId,
    },
    evidence: {
      kind: SIGNAL_KIND.WORK_DEADLINE_AT_RISK,
      obligationEntityId: obligation.entityId,
      ownerUserId: obligation.ownerUserId,
      hardDeadlineDate,
      workingTargetDate: obligation.workingTargetDate,
      daysUntilDeadline,
      obligationStatus: obligation.status,
    },
    suggestions: [{ kind: SUGGESTION_KIND.ASSIGN }],
    dedupeKey: deadlineAtRiskDedupeKey(obligation.entityId, hardDeadlineDate),
  };
};

/**
 * Every signal one open obligation warrants right now. The two kinds are
 * independent: an unanswered assignment whose deadline is also closing emits
 * both, because they need different answers from a supervisor.
 */
export const workAttentionSignals = (
  obligation: WorkAttentionObligation,
  now: Date,
): NewSignal[] => {
  const signals: NewSignal[] = [];
  const daysWaiting = daysWaitingSince(obligation.assignedAt, now);
  if (
    obligation.status === WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT &&
    daysWaiting >= WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS
  ) {
    signals.push(unacknowledgedSignal(obligation, daysWaiting));
  }

  const { hardDeadlineDate } = obligation;
  if (hardDeadlineDate !== null) {
    const daysUntilDeadline = daysUntilDate(hardDeadlineDate, now);
    if (daysUntilDeadline <= WORK_ATTENTION_DEADLINE_DAYS) {
      signals.push(
        deadlineAtRiskSignal(obligation, hardDeadlineDate, daysUntilDeadline),
      );
    }
  }

  return signals;
};
