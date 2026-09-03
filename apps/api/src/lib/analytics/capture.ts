import { getAnalytics } from "@/api/lib/analytics/client";
import type { ExceptionProperties } from "@/api/lib/analytics/types";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import {
  errorFingerprint,
  errorTag,
  logDevError,
  safeErrorTelemetryFields,
} from "@/api/lib/errors/utils";
import { getRequestContext } from "@/api/lib/observability/request-context";

/**
 * Capture an error for observability.
 *
 * - Dev: full error logged to `console.error` *and* appended to
 *   `apps/api/.dev-logs/errors.jsonl` (with the same `context`
 *   below) so headless tools can read it without holding the dev
 *   tty. Both paths are dev-only.
 * - Prod: only the structural error tag (class name), safe
 *   caller-provided correlation context, and authenticated
 *   request correlation IDs are sent to the analytics provider.
 *   Error messages, causes, and stack traces are never sent;
 *   they may contain privileged document content, file names,
 *   or client data.
 *
 * Pass `context` with safe correlation IDs (entity IDs, request
 * IDs) to make errors traceable without leaking content.
 */
export type ErrorTelemetryContext = Record<string, string>;

type CaptureErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  distinctId?: string | undefined;
  organizationId?: string | undefined;
  sessionId?: string | undefined;
};

type CaptureRequestErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  request: Request;
};

const SERVER_DISTINCT_ID = "server";

const CAPTURE_WINDOW_MS = 60_000;
const CAPTURE_MAX_TRACKED_KEYS = 500;

type CaptureWindow = { startedAt: number; suppressed: number };

const captureWindows = new Map<string, CaptureWindow>();

/**
 * Structural key for repeat suppression: error class, stable code, and code
 * location, deliberately excluding the caller's correlation context.
 *
 * A stuck loop re-reports the same defect with a fresh request or entity ID
 * every cycle, so keying on context would defeat the throttle in exactly the
 * case that motivates it. Two call sites that genuinely share a class, code,
 * and frame are the same defect.
 */
const captureWindowKey = (properties: ExceptionProperties): string => {
  // `ExceptionProperties` widens every value to include `$exception_list`, so
  // read each field back as a string rather than stringifying whatever is there.
  const field = (key: string): string => {
    const value = properties[key];
    return typeof value === "string" ? value : "";
  };
  return [
    field("error.class"),
    field("error.code"),
    field("error.frame"),
    field("error.cause.frame"),
  ].join("|");
};

/**
 * Drop the key whose window opened longest ago once the map is full, so a
 * process that sees an unbounded variety of errors cannot grow this map
 * without limit. Evicting an old window at worst re-reports its next
 * occurrence immediately, which is the safe direction.
 */
const evictOldestCaptureWindow = (key: string): void => {
  if (
    captureWindows.has(key) ||
    captureWindows.size < CAPTURE_MAX_TRACKED_KEYS
  ) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestStartedAt = Number.POSITIVE_INFINITY;
  for (const [candidate, window] of captureWindows) {
    if (window.startedAt < oldestStartedAt) {
      oldestStartedAt = window.startedAt;
      oldestKey = candidate;
    }
  }
  if (oldestKey !== undefined) {
    captureWindows.delete(oldestKey);
  }
};

/**
 * Rate-limit identical errors to one reported event per window.
 *
 * Returns the number of occurrences suppressed since the last report, or
 * `null` when this occurrence is itself suppressed. A persistently failing
 * loop otherwise spends one ingested event per iteration, all carrying the
 * same structural payload, since the redaction contract above means repeats
 * differ only in correlation IDs.
 *
 * The suppressed count rides along on the next reported event rather than
 * being dropped, so the failure's rate stays recoverable and nothing is
 * silently swallowed. Counting is lazy: the tail of a window that never sees
 * another occurrence is not reported, which is the case where the error has
 * stopped and the rate no longer matters.
 */
const admitCapture = (key: string, now: number): number | null => {
  const open = captureWindows.get(key);
  if (open !== undefined && now - open.startedAt < CAPTURE_WINDOW_MS) {
    open.suppressed += 1;
    return null;
  }
  evictOldestCaptureWindow(key);
  captureWindows.set(key, { startedAt: now, suppressed: 0 });
  return open?.suppressed ?? 0;
};

/**
 * Reset the suppression state. Tests only: the windows are module state, so
 * one test's captures would otherwise throttle the next test's.
 */
export const resetCaptureWindows = (): void => {
  captureWindows.clear();
};

const captureErrorWithOptions = (
  error: unknown,
  options: CaptureErrorOptions,
) => {
  const tag = errorTag(error);
  const fingerprint = errorFingerprint(error);
  // PostHog ingestion drops `$exception` events that lack `$exception_list`,
  // so the entry is required even though we deliberately keep it empty —
  // the redaction contract above forbids shipping the message or stack.
  const properties: ExceptionProperties = {
    // PostHog groups issues from `$exception_list` content; with the message
    // and stack redacted, every event of one error class collapses into a
    // single issue and first-seen automations never fire for new defects.
    // Group by the structural fingerprint instead: same non-PII components,
    // one issue per distinct defect. Positions are fixed (empty stays empty)
    // so a frameless error's cause frame can never collide with another
    // error's primary frame — the same shape `captureWindowKey` uses.
    $exception_fingerprint: [
      fingerprint["error.class"] ?? "",
      fingerprint["error.code"] ?? "",
      fingerprint["error.frame"] ?? "",
      fingerprint["error.cause.frame"] ?? "",
    ].join("|"),
    $exception_level: "error",
    $exception_list: [
      {
        mechanism: { handled: true, synthetic: false, type: "generic" },
        type: tag,
        value: "",
      },
    ],
    $exception_type: tag,
    // Non-PII structural fingerprint (class, stable code, top
    // `file:line:col` frames). The redaction contract above still
    // forbids the message and stack; a code location and class name
    // carry no client data, so they make the exception actionable in
    // the dashboard without violating it.
    ...fingerprint,
    ...options.context,
    ...safeErrorTelemetryFields(error),
    ...(options.organizationId
      ? { organization_id: options.organizationId }
      : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  };

  // Before the throttle: dev sinks are local and unmetered, and a developer
  // reproducing a tight failure loop needs every occurrence.
  logDevError(error, properties);

  const suppressed = admitCapture(captureWindowKey(properties), Date.now());
  if (suppressed === null) {
    return;
  }

  getAnalytics().capture({
    distinctId: options.distinctId ?? SERVER_DISTINCT_ID,
    event: SERVER_ANALYTICS_EVENTS.exception,
    ...(options.organizationId
      ? { groups: { organization: options.organizationId } }
      : {}),
    properties:
      suppressed > 0
        ? { ...properties, suppressed_repeats: String(suppressed) }
        : properties,
  });
};

export const captureError = (
  error: unknown,
  context?: ErrorTelemetryContext,
) => {
  captureErrorWithOptions(error, { context });
};

export const captureRequestError = (
  error: unknown,
  { context, request }: CaptureRequestErrorOptions,
) => {
  const reqCtx = getRequestContext(request);
  captureErrorWithOptions(error, {
    context,
    distinctId: reqCtx?.posthogDistinctId,
    organizationId: reqCtx?.organizationId,
    sessionId: reqCtx?.sessionId,
  });
};
