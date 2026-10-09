import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { SchedulerDailySchedule } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY,
  type FlowScheduleFrequency,
  type FlowTrigger,
} from "@/api/lib/flows/flow-types";
import type { DueSlot } from "@/api/lib/scheduler/due-slot";

/**
 * Pure decision logic for the automation triggers (Phase 3a). Everything here
 * is side-effect free and unit-tested in `flow-trigger-logic.test.ts`: file
 * upload trigger matching, the daily spend-cap predicate, and the mapping of a
 * flow `schedule` trigger onto the generic scheduler's daily-clock format plus
 * the per-tick "is today the right day" gate for weekly / monthly frequencies.
 */

/** Weekday numbers of a flow schedule: 0 is Sunday, 6 is Saturday. */
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

type FileUploadTriggerMatchesSqlOptions = {
  trigger: SQLWrapper;
  workspaceId: SQLWrapper | string;
  extension: SQLWrapper | string | null;
};

/** SQL counterpart keeps eligible receipts ahead of bounded recovery pages. */
export const fileUploadTriggerMatchesSql = ({
  trigger,
  workspaceId,
  extension,
}: FileUploadTriggerMatchesSqlOptions) => sql`(
  ${trigger}->>'type' = 'file-upload'
  AND (
    CASE WHEN ${trigger}->'workspaceIds' = 'null'::jsonb THEN true ELSE EXISTS (SELECT 1 FROM jsonb_array_elements_text(NULLIF(${trigger}->'workspaceIds', 'null'::jsonb)) AS selected_workspace(value) WHERE selected_workspace.value = (${workspaceId})::text) END
  )
  AND (
    CASE WHEN ${trigger}->'fileExtensions' = 'null'::jsonb THEN true ELSE EXISTS (SELECT 1 FROM jsonb_array_elements_text(NULLIF(${trigger}->'fileExtensions', 'null'::jsonb)) AS selected_extension(value) WHERE lower(ltrim(selected_extension.value, '.')) = ${extension}) END
  )
)`;

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
 * `isScheduledFlowDue` gates weekly / monthly frequencies per slot.
 */
const FLOW_SCHEDULE_HOUR_KEY = "hourUtc";
const SCHEDULER_HOUR_KEY = "hour";
const FLOW_SCHEDULER_CLOCK = {
  type: "daily",
  minute: 0,
  timeZone: "UTC",
} as const;

export const flowScheduleToSchedulerSchedule = (
  schedule: FlowSchedule,
): SchedulerDailySchedule => ({
  ...FLOW_SCHEDULER_CLOCK,
  [SCHEDULER_HOUR_KEY]: schedule[FLOW_SCHEDULE_HOUR_KEY],
});

/** Uses the same clock fields and source-hour key as the runtime mapping. */
export const flowScheduleToSchedulerScheduleSql = (schedule: SQLWrapper) =>
  sql`${JSON.stringify(FLOW_SCHEDULER_CLOCK)}::text::jsonb || jsonb_build_object(${SCHEDULER_HOUR_KEY}::text, ${schedule}->${FLOW_SCHEDULE_HOUR_KEY}::text)`;

/**
 * Per-slot gate for the daily scheduler job. `daily` always runs; `weekly` runs
 * only when a covered slot's day (in the zone the tick is scheduled in) is
 * `dayOfWeek`; `monthly` only when it is `dayOfMonth`. The gate reads the slots
 * the claim covers, never the wall clock: a Monday 23:00 slot claimed after
 * midnight is still Monday's run, a Sunday 23:00 slot claimed early on Monday
 * is not, and a Sunday 09:00 slot claimed on Monday after 09:00 also covers
 * Monday's slot, which the runner would otherwise skip when it schedules the
 * next slot after the run.
 * A weekly / monthly schedule missing its day field cannot be gated to a
 * specific day, so it fails closed (never fires) rather than degrading to a
 * daily run: the frontend always supplies the field, so a missing one means a
 * malformed schedule that must not silently multiply automated runs (and their
 * AI spend) across every daily tick.
 */
export const isScheduledFlowDue = (
  schedule: FlowSchedule,
  slot: DueSlot,
): boolean => {
  const frequency: FlowScheduleFrequency = schedule.frequency;
  if (frequency === "daily") {
    return true;
  }
  const days = slot.elapsedDailySlotDaysIn(
    flowScheduleToSchedulerSchedule(schedule).timeZone,
  );
  if (frequency === "weekly") {
    const { dayOfWeek } = schedule;
    if (
      dayOfWeek === undefined ||
      dayOfWeek < UTC_WEEKDAY_MIN ||
      dayOfWeek > UTC_WEEKDAY_MAX
    ) {
      return false;
    }
    return days.some((day) => day.dayOfWeek % 7 === dayOfWeek);
  }
  const { dayOfMonth } = schedule;
  if (dayOfMonth === undefined) {
    return false;
  }
  return days.some((day) => day.day === dayOfMonth);
};
