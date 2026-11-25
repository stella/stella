import { Result } from "better-result";
import type { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { HarnessFailure } from "../events";
import type { CodexRateLimits, CodexTurnError } from "./protocol";

/**
 * Typed failure states for a failed Codex turn. Reset-time derivation adapted
 * from t3code (MIT, `codexUsageLimits.ts`): a continuation can run only once
 * every exhausted window has reset, so the latest reset time wins.
 */

const EXHAUSTED_PERCENT = 100;
const HTTP_UNAUTHORIZED = 401;
/** Codex's error code for a model at capacity. */
const SERVER_OVERLOADED = "serverOverloaded";
const USAGE_LIMIT_EXCEEDED = "usageLimitExceeded";

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
    credits: update.credits === undefined ? previous.credits : update.credits,
  };
};

/**
 * When the plan's exhausted windows reset. `null` when none is exhausted, or
 * one is and its reset is unknown. A window whose reset is not after `now`
 * has already reset, whatever its percentage says, so it limits nothing.
 */
export const usageLimitResetsAt = (
  limits: CodexRateLimits | null,
  now: Temporal.Instant,
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
    if (window.resetsAt * 1000 > now.epochMilliseconds) {
      resets.push(window.resetsAt);
    }
  }
  if (resets.length === 0) {
    return null;
  }
  const resetsAt = new Date(Math.max(...resets) * 1000);
  // A reset time past the representable range is as good as unknown.
  return Number.isNaN(resetsAt.getTime()) ? null : resetsAt.toISOString();
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

/**
 * The selected model was at capacity (`serverOverloaded`), a transient state
 * of the provider; the member's own allowance is `usageLimitExceeded`. Codex
 * itself retries transient errors inside a turn; this one ends the turn, and
 * a continuation on the same thread is how it resumes (approach from t3code,
 * MIT, `CodexAdapterV2.ts`).
 */
export const isCapacityFailure = (error: CodexTurnError | null): boolean =>
  errorCode(error?.codexErrorInfo ?? null) === SERVER_OVERLOADED;

/** The member's plan allowance ran out, which its rate limits time. */
export const isPlanUsageLimit = (error: CodexTurnError | null): boolean =>
  errorCode(error?.codexErrorInfo ?? null) === USAGE_LIMIT_EXCEEDED;

type ClassifyTurnFailureOptions = {
  error: CodexTurnError | null;
  rateLimits: CodexRateLimits | null;
  now: Temporal.Instant;
};

/**
 * Codex reports an exhausted ChatGPT Subscription Sharing allowance as a stream
 * disconnect that only its text tells apart (approach from t3code, MIT,
 * pingdotgg/t3code#25341).
 */
const SHARING_LIMIT_TEXT = "has reached their Subscription Sharing usage limit";
/** Codex rejects a thread whose encrypted history cannot be verified (t3code, MIT, pingdotgg/t3code#36643). */
const INVALID_ENCRYPTED_CONTENT = "invalid_encrypted_content";
const isEncryptedHistoryRejection = (error: CodexTurnError | null): boolean =>
  errorCode(error?.codexErrorInfo ?? null) === INVALID_ENCRYPTED_CONTENT ||
  (error?.message.includes(INVALID_ENCRYPTED_CONTENT) ?? false);

/**
 * Codex's wording of a credential the service refused: expired, revoked or
 * missing. Codex sends some of these as errors it will retry, which only
 * replays its reconnect schedule before it fails the same way.
 */
const AUTH_TEXT: readonly RegExp[] = [
  /\b401\s+(?:unauthorized|invalid authentication)\b/iu,
  /\baccess token (?:expired|could not be refreshed)\b/iu,
  /\b(?:invalid|missing) (?:api key|authentication|authorization)\b/iu,
  /\bmissing bearer\b/iu,
  /\bauthentication credentials\b/iu,
  /\bexpired credential\b/iu,
  /\brefresh token (?:has been |is |was )?revoked\b/iu,
  /\brequires openai auth\b/iu,
];

/** Signing in again is what the error needs: by its code, status or text. */
export const isAuthFailure = (error: CodexTurnError | null): boolean => {
  const info = error?.codexErrorInfo ?? null;
  if (
    errorCode(info) === "unauthorized" ||
    httpStatus(info) === HTTP_UNAUTHORIZED
  ) {
    return true;
  }
  const message = error?.message ?? "";
  return AUTH_TEXT.some((pattern) => pattern.test(message));
};

/**
 * Codex reads its project configuration from its own working directory, the
 * run's folder, so a folder deleted or replaced while it runs fails every
 * configuration load with a bare "No such file or directory".
 */
const CONFIG_LOAD_FAILURE =
  /^(?:failed to load configuration|failed to resolve feature override precedence): .*No such file or directory/su;
/** The ChatGPT workspace lookup Codex makes before each model request got no answer. */
const WORKSPACE_ROUTING_UNAVAILABLE: ReadonlySet<string> = new Set([
  "workspace routing discovery failed",
  "workspace routing discovery timed out",
]);
const SERVICE_ERROR_TYPES = [
  "invalid_request_error",
  "server_error",
  "rate_limit_error",
  "insufficient_quota",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "overloaded_error",
] as const;
const HTTP_ERROR_MIN = 400;
const HTTP_ERROR_MAX = 599;

/** The provider's JSON error, which Codex passes on as its whole text. */
const ServiceErrorEnvelopeSchema = v.strictObject({
  type: v.literal("error"),
  status: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(HTTP_ERROR_MIN),
    v.maxValue(HTTP_ERROR_MAX),
  ),
  error: v.strictObject({
    type: v.picklist(SERVICE_ERROR_TYPES),
    message: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    code: v.optional(v.nullable(v.string())),
    param: v.optional(v.nullable(v.string())),
  }),
});

const parsedJson = (text: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

/** Codex's reconnect notice: `Reconnecting... 2/5`, then the cause. */
const RECONNECT_ATTEMPT = /^Reconnecting\.{3} (\d+)\/(\d+)\b/u;

/**
 * Which attempt a retry Codex announced is, of how many, from its reconnect
 * notice; both `null` when the error names no count.
 */
export const codexRetryAttempt = (
  error: CodexTurnError,
): { attempt: number | null; maxAttempts: number | null } => {
  const counted = RECONNECT_ATTEMPT.exec(error.message.trim());
  return counted === null
    ? { attempt: null, maxAttempts: null }
    : { attempt: Number(counted[1]), maxAttempts: Number(counted[2]) };
};

/**
 * Codex's error text in words a member can act on: a deleted run folder, an
 * unreachable ChatGPT workspace lookup, or the message inside the provider's
 * JSON error. Any other text is returned as it is.
 */
export const readableCodexMessage = (message: string): string => {
  if (CONFIG_LOAD_FAILURE.test(message)) {
    return "Codex cannot read its configuration because the run's folder was deleted or replaced after Codex started. Check that the folder exists, then send the message again.";
  }
  const trimmed = message.trim();
  if (WORKSPACE_ROUTING_UNAVAILABLE.has(trimmed)) {
    return `Codex cannot reach chatgpt.com to look up your ChatGPT workspace. Check your network connection and any proxy, VPN or firewall that blocks chatgpt.com, then try again. (${trimmed})`;
  }
  const envelope = v.safeParse(ServiceErrorEnvelopeSchema, parsedJson(trimmed));
  return envelope.success ? envelope.output.error.message : message;
};

export const classifyTurnFailure = ({
  error,
  rateLimits,
  now,
}: ClassifyTurnFailureOptions): HarnessFailure => {
  const message = readableCodexMessage(
    error?.message ?? "The harness turn failed.",
  );
  const info = error?.codexErrorInfo ?? null;
  const code = errorCode(info);
  if (isAuthFailure(error)) {
    return { type: "auth_required", message };
  }
  if (code === USAGE_LIMIT_EXCEEDED) {
    return {
      type: "usage_limit",
      message,
      resetsAt: usageLimitResetsAt(rateLimits, now),
    };
  }
  // Reached once the continuations are spent, or when no turn may continue.
  if (code === SERVER_OVERLOADED) {
    return { type: "model_at_capacity", message };
  }
  if (error?.message.includes(SHARING_LIMIT_TEXT) === true) {
    // This allowance has its own reset, which the plan's rate limits do not say.
    return { type: "usage_limit", message, resetsAt: null };
  }
  if (isEncryptedHistoryRejection(error)) {
    return {
      type: "provider_error",
      message:
        "Codex could not verify this session's encrypted conversation history. Send another message to continue in a fresh session with the visible conversation history.",
      code: INVALID_ENCRYPTED_CONTENT,
    };
  }
  return { type: "provider_error", message, code };
};
