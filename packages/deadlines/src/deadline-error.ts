import { TaggedError } from "better-result";

export class DeadlineError extends TaggedError("DeadlineError")<{
  message: string;
  reason:
    | "unsupported_jurisdiction"
    | "unsupported_date"
    | "calendar_failure"
    | "adjustment_limit"
    | "counting_limit"
    | "invalid_rule"
    | "unsupported_calendar_capability";
  jurisdiction?: string;
  date?: string;
  cause?: unknown;
}> {}
