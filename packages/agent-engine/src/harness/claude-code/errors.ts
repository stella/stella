import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import type { HarnessFailure } from "../events";
import type {
  ClaudeRateLimitInfo,
  ClaudeResultMessage,
  ClaudeUsageWindows,
} from "./protocol";

/**
 * Typed failure states for a failed Claude Code turn, and the time a usage
 * limit resets. Only the plan's main windows (five hours, seven days) block
 * the harness; a model-specific window limits that model alone. A
 * continuation can run only once every exhausted window has reset, so the
 * latest reset time wins. Window reading adapted from t3code (MIT,
 * `claudeUsageLimits.ts`).
 */

const EXHAUSTED_PERCENT = 100;
const HTTP_UNAUTHORIZED = 401;

/** Rate-limit windows that block every model. */
const MAIN_WINDOWS: ReadonlySet<string> = new Set(["five_hour", "seven_day"]);

/** Assistant-message error codes that mean the sign-in no longer works. */
const AUTH_ERRORS: ReadonlySet<string> = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
]);
const RATE_LIMIT_ERROR = "rate_limit";

const latest = (instants: readonly Temporal.Instant[]): string | null => {
  let max: Temporal.Instant | null = null;
  for (const instant of instants) {
    if (max === null || Temporal.Instant.compare(instant, max) > 0) {
      max = instant;
    }
  }
  return max?.toString() ?? null;
};

/**
 * A rejection the CLI streamed for one window, as the instant it resets.
 * Kept only when it blocks every model; the reset is in Unix seconds.
 */
export const blockingReset = (
  info: ClaudeRateLimitInfo,
): Temporal.Instant | null => {
  if (
    info.status !== "rejected" ||
    info.resetsAt === undefined ||
    !Number.isFinite(info.resetsAt) ||
    info.resetsAt <= 0
  ) {
    return null;
  }
  if (
    info.rateLimitType !== undefined &&
    !MAIN_WINDOWS.has(info.rateLimitType)
  ) {
    return null;
  }
  return Temporal.Instant.fromEpochMilliseconds(
    Math.round(info.resetsAt * 1000),
  );
};

/**
 * When the plan's exhausted windows reset, from `get_usage`. `null` when no
 * main window is exhausted, or one is and its reset is unknown.
 */
export const usageLimitResetsAt = (
  windows: ClaudeUsageWindows | null,
): string | null => {
  const resets: Temporal.Instant[] = [];
  for (const window of [windows?.five_hour, windows?.seven_day]) {
    if (
      window === undefined ||
      window === null ||
      window.utilization === null ||
      window.utilization < EXHAUSTED_PERCENT
    ) {
      continue;
    }
    const resetsAt = window.resets_at;
    const instant =
      resetsAt === null
        ? null
        : Result.try(() => Temporal.Instant.from(resetsAt));
    if (instant === null || Result.isError(instant)) {
      // One exhausted window without a readable reset: the reset is unknown.
      return null;
    }
    resets.push(instant.value);
  }
  return latest(resets);
};

type ClassifyResultFailureOptions = {
  result: ClaudeResultMessage;
  /** The `error` code of the turn's last synthetic assistant message. */
  assistantError: string | null;
  /** Resets of rejected main windows the CLI streamed during the turn. */
  rejectedResets: readonly Temporal.Instant[];
};

export const classifyResultFailure = ({
  result,
  assistantError,
  rejectedResets,
}: ClassifyResultFailureOptions): HarnessFailure => {
  const message =
    (result.errors ?? []).join("\n").trim() ||
    result.result?.trim() ||
    "The harness turn failed.";
  if (
    (assistantError !== null && AUTH_ERRORS.has(assistantError)) ||
    result.api_error_status === HTTP_UNAUTHORIZED
  ) {
    return { type: "auth_required", message };
  }
  if (assistantError === RATE_LIMIT_ERROR) {
    return { type: "usage_limit", message, resetsAt: latest(rejectedResets) };
  }
  return {
    type: "provider_error",
    message,
    code: assistantError ?? result.subtype,
  };
};
