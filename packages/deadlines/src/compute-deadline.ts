import {
  createDeadlineCalculator,
  type DeadlineInput,
  type DeadlineResult,
} from "./deadline-calculator";
import type { HolidayCalendar } from "./deadline-calendar";
import { createHolidayCalendar } from "./holiday-calendar";
import { DEADLINE_RULES, type DeadlineJurisdiction } from "./rules";

export { createDeadlineCalculator } from "./deadline-calculator";
export type {
  DeadlineCalculation,
  DeadlineInput,
  DeadlineResult,
  DeadlineShift,
} from "./deadline-calculator";
export { getNonWorkingReason } from "./deadline-calendar";
export type {
  HolidayCalendar,
  HolidayDateOptions,
  NonWorkingReason,
  PublicHoliday,
} from "./deadline-calendar";
export { DeadlineError } from "./deadline-error";
export { createHolidayCalendar, HOLIDAY_COVERAGE } from "./holiday-calendar";
export {
  computeNominalEnd,
  DEADLINE_UNIT,
  NominalDeadlineError,
} from "./nominal-end";
export type {
  ComputeNominalEndOptions,
  DeadlinePeriod,
  DeadlineUnit,
} from "./nominal-end";
export { DEADLINE_RULES } from "./rules";
export type {
  DeadlineJurisdiction,
  DeadlineRuleSet,
  IsoDayOfWeek,
} from "./rules";

export type ComputeDeadlineOptions = DeadlineInput<DeadlineJurisdiction> & {
  calendar?: HolidayCalendar;
};

export type ComputeDeadlineResult = DeadlineResult<DeadlineJurisdiction>;

export const computeDeadline = ({
  jurisdiction,
  trigger,
  period,
  calendar = createHolidayCalendar(),
}: ComputeDeadlineOptions): ComputeDeadlineResult =>
  createDeadlineCalculator({ rules: DEADLINE_RULES, calendar })({
    jurisdiction,
    trigger,
    period,
  });
