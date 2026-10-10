import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { parsePlainDate, Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  DEFAULT_TIME_EDIT_WINDOW_DAYS,
  DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  DEFAULT_TIME_NARRATIVE_REQUIRED,
  organizationSettings,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const DEFAULT_TIME_POLICY = {
  timeMinimumUnitMinutes: DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  timeEditWindowDays: DEFAULT_TIME_EDIT_WINDOW_DAYS,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: DEFAULT_TIME_NARRATIVE_REQUIRED,
} as const;

export type TimePolicy = {
  timeMinimumUnitMinutes: number;
  timeEditWindowDays: number;
  timeLockedThroughMonth: string | null;
  timeNarrativeRequired: boolean;
};

export const readTimePolicy = async ({
  safeDb,
  organizationId,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
}) => {
  const row = await safeDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: {
        timeMinimumUnitMinutes: true,
        timeEditWindowDays: true,
        timeLockedThroughMonth: true,
        timeNarrativeRequired: true,
      },
    }),
  );
  return row.map(toTimePolicy);
};

type TimePolicySettings = Pick<
  typeof organizationSettings.$inferSelect,
  | "timeMinimumUnitMinutes"
  | "timeEditWindowDays"
  | "timeLockedThroughMonth"
  | "timeNarrativeRequired"
>;
const toTimePolicy = (settings: TimePolicySettings | undefined) => ({
  timeMinimumUnitMinutes:
    settings?.timeMinimumUnitMinutes ??
    DEFAULT_TIME_POLICY.timeMinimumUnitMinutes,
  timeEditWindowDays:
    settings?.timeEditWindowDays ?? DEFAULT_TIME_POLICY.timeEditWindowDays,
  timeLockedThroughMonth: settings?.timeLockedThroughMonth ?? null,
  timeNarrativeRequired:
    settings?.timeNarrativeRequired ??
    DEFAULT_TIME_POLICY.timeNarrativeRequired,
});

/** Keep approval decisions serialized with concurrent month-closing updates. */
export const lockTimePolicy = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  // Materialize the optional defaults so a concurrent first update has a row to lock.
  await tx
    .insert(organizationSettings)
    .values({ id: createSafeId<"organizationSettings">(), organizationId })
    .onConflictDoNothing({ target: organizationSettings.organizationId });
  const [settings] = await tx
    .select({
      timeMinimumUnitMinutes: organizationSettings.timeMinimumUnitMinutes,
      timeEditWindowDays: organizationSettings.timeEditWindowDays,
      timeLockedThroughMonth: organizationSettings.timeLockedThroughMonth,
      timeNarrativeRequired: organizationSettings.timeNarrativeRequired,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
    .for("share");
  if (!settings) {
    return panic("Time policy disappeared after initialization");
  }
  return toTimePolicy(settings);
};

export const roundToBillingIncrement = (
  minutes: number,
  minimumUnitMinutes: number,
): number => Math.ceil(minutes / minimumUnitMinutes) * minimumUnitMinutes;

const getTimeEntryDateValidationError = ({
  dateWorked,
  today,
  editWindowDays,
}: {
  dateWorked: string;
  today: string;
  editWindowDays: number | null;
}): HandlerError<400> | null => {
  const workedDate = parsePlainDate(dateWorked);
  if (workedDate === null) {
    return new HandlerError({
      status: 400,
      code: "invalid_date_worked",
      message: "Date worked must be a valid calendar date",
      hint: "Use a calendar date in YYYY-MM-DD format.",
    });
  }
  const todayDate =
    parsePlainDate(today) ??
    panic("Current date must be a normalized ISO calendar date");

  if (Temporal.PlainDate.compare(workedDate, todayDate) > 0) {
    return new HandlerError({
      status: 400,
      code: "future_date_worked",
      message: "Date worked cannot be in the future",
      hint: "Choose today or an earlier date.",
    });
  }

  if (
    editWindowDays !== null &&
    todayDate.since(workedDate).days > editWindowDays
  ) {
    return new HandlerError({
      status: 400,
      code: "outside_edit_window",
      message: `Date worked is outside the ${editWindowDays}-day edit window`,
      hint: "Ask a time approver to make this change, or choose a newer date.",
    });
  }

  return null;
};

export const getTimePolicyViolation = ({
  policy,
  dateWorked,
  today,
  canApprove,
  narrative,
}: {
  policy: TimePolicy;
  dateWorked: string;
  today: string;
  canApprove: boolean;
  narrative?: string | undefined;
}): HandlerError<400> | null => {
  const lockError = getTimePeriodLockError(policy, dateWorked);
  if (lockError) {
    return lockError;
  }
  const dateError = getTimeEntryDateValidationError({
    dateWorked,
    today,
    editWindowDays: canApprove ? null : policy.timeEditWindowDays,
  });
  if (dateError) {
    return dateError;
  }
  if (
    policy.timeNarrativeRequired &&
    narrative !== undefined &&
    !narrative.trim()
  ) {
    return new HandlerError({
      status: 400,
      code: "narrative_required",
      message: "A narrative is required for time entries",
      hint: "Add a description of the work.",
    });
  }
  return null;
};

export const getTimePeriodLockError = (
  policy: TimePolicy,
  dateWorked: string,
): HandlerError<400> | null =>
  policy.timeLockedThroughMonth !== null &&
  dateWorked <= policy.timeLockedThroughMonth
    ? new HandlerError({
        status: 400,
        code: "time_period_locked",
        message: "The time period is locked",
        hint: "Ask an organization administrator to move the locked-through month back.",
      })
    : null;
