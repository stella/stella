import { panic } from "better-result";
import * as v from "valibot";

import { parsePlainDate, Temporal, todayFor } from "@stll/time";

import type { TranslationKey } from "@/i18n/types";
import type { WebApiRoutes } from "@/lib/eden-client";
import { APIError } from "@/lib/errors/api";

const TIME_POLICY_FIELDS = [
  "timeMinimumUnitMinutes",
  "timeEditWindowDays",
  "timeLockedThroughMonth",
  "timeNarrativeRequired",
] as const satisfies readonly (keyof WebApiRoutes["organization-settings"]["post"]["body"])[];

type OrganizationSettings =
  WebApiRoutes["organization-settings"]["get"]["response"][200];

export type TimePolicy = Pick<
  OrganizationSettings,
  (typeof TIME_POLICY_FIELDS)[number]
>;

/**
 * The policy plus the organization's zone: a month is closable once it has
 * ended on the organization's day, the day the server's lock check reads.
 */
export type TimePolicySettings = TimePolicy &
  Pick<OrganizationSettings, "timeZone">;

export const TIME_UNIT_OPTIONS = [1, 5, 6, 10, 15, 30, 60] as const;

type MonthLock =
  | { type: "clear" }
  | { type: "locked"; date: string }
  | { type: "invalid" };

export const resolveMonthLock = (
  month: string,
  today: Temporal.PlainDate,
): MonthLock => {
  if (month === "") {
    return { type: "clear" };
  }
  const firstDay = parsePlainDate(`${month}-01`);
  if (firstDay === null || firstDay.year < 1) {
    return { type: "invalid" };
  }
  const lastDay = firstDay.with({ day: firstDay.daysInMonth });
  if (Temporal.PlainDate.compare(lastDay, today) >= 0) {
    return { type: "invalid" };
  }
  return { type: "locked", date: lastDay.toString() };
};

export const monthLockDate = (lock: MonthLock) => {
  switch (lock.type) {
    case "clear":
      return null;
    case "locked":
      return lock.date;
    case "invalid":
      return panic("Invalid month passed validated time policy form");
    default:
      lock satisfies never;
      return panic("Unknown month lock state");
  }
};

type TimePolicyPatchOptions = { original: TimePolicy; next: TimePolicy };
export const timePolicyPatch = ({ original, next }: TimePolicyPatchOptions) =>
  ({
    ...(original.timeMinimumUnitMinutes === next.timeMinimumUnitMinutes
      ? {}
      : { timeMinimumUnitMinutes: next.timeMinimumUnitMinutes }),
    ...(original.timeEditWindowDays === next.timeEditWindowDays
      ? {}
      : { timeEditWindowDays: next.timeEditWindowDays }),
    ...(original.timeLockedThroughMonth === next.timeLockedThroughMonth
      ? {}
      : { timeLockedThroughMonth: next.timeLockedThroughMonth }),
    ...(original.timeNarrativeRequired === next.timeNarrativeRequired
      ? {}
      : { timeNarrativeRequired: next.timeNarrativeRequired }),
  }) satisfies WebApiRoutes["organization-settings"]["post"]["body"];

const TIME_POLICY_REFUSALS = {
  invalid_time_minimum_unit:
    "settings.organization.timePolicy.invalidMinimumUnit",
  invalid_time_locked_month:
    "settings.organization.timePolicy.invalidLockedMonth",
} as const satisfies Record<string, TranslationKey>;

export const timePolicyErrorKey = (error: unknown) => {
  if (!APIError.is(error)) {
    return null;
  }
  switch (error.code) {
    case "invalid_time_minimum_unit":
      return TIME_POLICY_REFUSALS.invalid_time_minimum_unit;
    case "invalid_time_locked_month":
      return TIME_POLICY_REFUSALS.invalid_time_locked_month;
    case undefined:
      return null;
    default:
      return null;
  }
};

type TimePolicyValidationMessages = {
  minimumUnit: string;
  editWindow: string;
  lockedMonth: string;
};
type TimePolicyFormSchemaOptions = {
  /** The organization's zone: the server judges lock months on its day. */
  timeZone: string;
  messages: TimePolicyValidationMessages;
  at?: Temporal.Instant;
};
export const timePolicyFormSchema = ({
  timeZone,
  messages,
  at = Temporal.Now.instant(),
}: TimePolicyFormSchemaOptions) => {
  const today = todayFor(timeZone, at);
  return v.object({
    timeMinimumUnitMinutes: v.pipe(
      v.number(),
      v.integer(messages.minimumUnit),
      v.minValue(1, messages.minimumUnit),
      v.maxValue(60, messages.minimumUnit),
      v.check((value) => 60 % value === 0, messages.minimumUnit),
    ),
    timeEditWindowDays: v.pipe(
      v.string(),
      v.check(
        (value) => /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)),
        messages.editWindow,
      ),
      v.transform(Number),
    ),
    timeLockedThroughMonth: v.pipe(
      v.string(),
      v.check(
        (value) => resolveMonthLock(value, today).type !== "invalid",
        messages.lockedMonth,
      ),
      v.transform((value) => monthLockDate(resolveMonthLock(value, today))),
    ),
    timeNarrativeRequired: v.boolean(),
  });
};
