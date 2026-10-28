import type { HarnessFailure } from "../events";
import type { CodexRateLimits, CodexTurnError } from "./protocol";

/**
 * Typed failure states for a failed Codex turn. Reset-time derivation adapted
 * from t3code (MIT, `codexUsageLimits.ts`): a continuation can run only once
 * every exhausted window has reset, so the latest reset time wins.
 */

const EXHAUSTED_PERCENT = 100;
const HTTP_UNAUTHORIZED = 401;

/** Rate-limit updates are partial; omitted windows keep earlier values. */
export const mergeRateLimits = (
  previous: CodexRateLimits | null,
  update: CodexRateLimits,
): CodexRateLimits | null => {
  // Model-specific limits must not overwrite the main allowance.
  if (
    update.limitId !== undefined &&
    update.limitId !== null &&
    update.limitId !== "codex"
  ) {
    return previous;
  }
  if (previous === null) {
    return update;
  }
  return {
    limitId: update.limitId ?? previous.limitId,
    primary: update.primary === undefined ? previous.primary : update.primary,
    secondary:
      update.secondary === undefined ? previous.secondary : update.secondary,
  };
};

export const usageLimitResetsAt = (
  limits: CodexRateLimits | null,
): string | null => {
  const resets: number[] = [];
  for (const window of [limits?.primary, limits?.secondary]) {
    if (
      window === undefined ||
      window === null ||
      window.usedPercent < EXHAUSTED_PERCENT
    ) {
      continue;
    }
    if (typeof window.resetsAt !== "number" || window.resetsAt <= 0) {
      // One exhausted window without a reset time: the reset is unknown.
      return null;
    }
    resets.push(window.resetsAt);
  }
  if (resets.length === 0) {
    return null;
  }
  return new Date(Math.max(...resets) * 1000).toISOString();
};

/** The upstream error code: a string variant, or the key of an object one. */
const errorCode = (info: CodexTurnError["codexErrorInfo"]): string => {
  if (info === null) {
    return "unknown";
  }
  if (typeof info === "string") {
    return info;
  }
  return Object.keys(info).at(0) ?? "unknown";
};

const httpStatus = (info: CodexTurnError["codexErrorInfo"]): number | null => {
  if (info === null || typeof info === "string") {
    return null;
  }
  for (const detail of Object.values(info)) {
    if (
      typeof detail === "object" &&
      detail !== null &&
      "httpStatusCode" in detail &&
      typeof detail.httpStatusCode === "number"
    ) {
      return detail.httpStatusCode;
    }
  }
  return null;
};

type ClassifyTurnFailureOptions = {
  error: CodexTurnError | null;
  rateLimits: CodexRateLimits | null;
};

export const classifyTurnFailure = ({
  error,
  rateLimits,
}: ClassifyTurnFailureOptions): HarnessFailure => {
  const message = error?.message ?? "The harness turn failed.";
  const info = error?.codexErrorInfo ?? null;
  const code = errorCode(info);
  if (code === "unauthorized" || httpStatus(info) === HTTP_UNAUTHORIZED) {
    return { type: "auth_required", message };
  }
  if (code === "usageLimitExceeded") {
    return {
      type: "usage_limit",
      message,
      resetsAt: usageLimitResetsAt(rateLimits),
    };
  }
  return { type: "provider_error", message, code };
};
