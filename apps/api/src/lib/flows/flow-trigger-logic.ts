import type { SchedulerDailySchedule } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY,
  type FlowScheduleFrequency,
  type FlowTrigger,
} from "@/api/lib/flows/flow-types";

/**
 * Pure decision logic for the automation triggers (Phase 3a). Everything here
 * is side-effect free and unit-tested in `flow-trigger-logic.test.ts`: file
 * upload trigger matching, the daily spend-cap predicate, and the mapping of a
 * flow `schedule` trigger onto the generic scheduler's daily-clock format plus
 * the per-tick "is today the right day" gate for weekly / monthly frequencies.
 */

/** UTC weekday constants (matches `Date.prototype.getUTCDay`). */
const UTC_WEEKDAY_MIN = 0;
const UTC_WEEKDAY_MAX = 6;

type FileUploadTrigger = Extract<FlowTrigger, { type: "file-upload" }>;
type FlowSchedule = Extract<FlowTrigger, { type: "schedule" }>["schedule"];

/**
 * Lowercased file extension without the leading dot, or `null` when the name
 * has no extension. Only the final segment counts (`a.tar.gz` -> `gz`), which
 * is what a user picks from in the trigger's extension list.
 */
export const deriveFileExtension = (fileName: string): string | null => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(lastDot + 1).toLowerCase();
};

/** Normalize a configured extension for case-insensitive, dot-agnostic compare. */
const normalizeConfiguredExtension = (value: string): string =>
  value.replace(/^\.+/u, "").toLowerCase();

export type FileUploadTriggerMatchInput = {
  trigger: FileUploadTrigger;
  workspaceId: SafeId<"workspace">;
  /** Result of `deriveFileExtension` for the uploaded entity. */
  extension: string | null;
};

/**
 * Whether a completed user upload should fire this file-upload trigger. A
 * `null` workspace filter matches every workspace; a `null` extension filter
 * matches any file. Extension comparison is case-insensitive and ignores a
 * leading dot on either side.
 */
export const fileUploadTriggerMatches = ({
  trigger,
  workspaceId,
  extension,
}: FileUploadTriggerMatchInput): boolean => {
  if (
    trigger.workspaceIds !== null &&
    !trigger.workspaceIds.includes(workspaceId)
  ) {
    return false;
  }
  if (trigger.fileExtensions === null) {
    return true;
  }
  if (extension === null) {
    return false;
  }
  return trigger.fileExtensions
    .map(normalizeConfiguredExtension)
    .includes(extension);
};

/**
 * Daily automated-run spend guard. `true` once a definition has already spawned
 * `MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY` schedule/file-upload runs
 * today, so the caller must skip starting another.
 */
export const isAutomatedRunCapReached = (
  todaysAutomatedRunCount: number,
): boolean =>
  todaysAutomatedRunCount >= MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY;

/**
 * Map a flow `schedule` trigger onto the generic scheduler's schedule format.
 * The scheduler only understands `daily` (a wall-clock hour:minute in a
 * timezone) and `interval`; there is no native weekly / monthly. Every flow
 * schedule therefore registers as a daily UTC tick at `hourUtc:00`, and
 * `shouldRunScheduledFlowNow` gates weekly / monthly frequencies per tick.
 */
export const flowScheduleToSchedulerSchedule = (
  schedule: FlowSchedule,
): SchedulerDailySchedule => ({
  type: "daily",
  hour: schedule.hourUtc,
  minute: 0,
  timeZone: "UTC",
});

/**
 * Per-tick gate for the daily scheduler job. `daily` always runs; `weekly` runs
 * only when today's UTC weekday equals `dayOfWeek`; `monthly` only when today's
 * UTC day-of-month equals `dayOfMonth`. A weekly / monthly schedule missing its
 * day field cannot be gated, so it degrades to running every day (the frontend
 * always supplies the field for those frequencies).
 */
export const shouldRunScheduledFlowNow = (
  schedule: FlowSchedule,
  now: Date,
): boolean => {
  const frequency: FlowScheduleFrequency = schedule.frequency;
  if (frequency === "daily") {
    return true;
  }
  if (frequency === "weekly") {
    if (schedule.dayOfWeek === undefined) {
      return true;
    }
    const weekday = now.getUTCDay();
    if (
      schedule.dayOfWeek < UTC_WEEKDAY_MIN ||
      schedule.dayOfWeek > UTC_WEEKDAY_MAX
    ) {
      return false;
    }
    return weekday === schedule.dayOfWeek;
  }
  if (schedule.dayOfMonth === undefined) {
    return true;
  }
  return now.getUTCDate() === schedule.dayOfMonth;
};
