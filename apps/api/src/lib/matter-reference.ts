import {
  toNumberPatternScopeKey,
  validateNumberPattern,
} from "@/api/lib/number-pattern";

export const validatePattern = (pattern: string, padding: number) =>
  validateNumberPattern({ pattern, padding, sequenceDigitsBudget: 6 });

export const toScopeKey = (pattern: string, now: Date) =>
  toNumberPatternScopeKey({ pattern, now });

export {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@stll/api-contract";
