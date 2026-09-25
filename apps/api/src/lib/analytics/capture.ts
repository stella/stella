import { Result } from "better-result";

import { createDetached } from "@stll/errors";
import { Temporal } from "@stll/time";

import { getServerAnalytics } from "@/api/lib/analytics/client";
import type { ExceptionProperties } from "@/api/lib/analytics/server-analytics";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import {
  errorTag,
  logServerDevError,
  safeErrorTelemetryFields,
} from "@/api/lib/errors/utils";
import type { FailureGrading } from "@/api/lib/observability/failure";
import { identityFields } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  observeShadow,
  reportEmitFailure,
  SHADOW_SINKS,
  shadowFields,
} from "@/api/lib/observability/failure-shadow";
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
type ErrorTelemetryContext = Record<string, string>;

type CaptureErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  distinctId?: string | undefined;
  organizationId?: string | undefined;
  sessionId?: string | undefined;
  request?: Request | undefined;
  /**
   * Set when the caller already observed and counted this failure; its grade
   * is undefined only if grading itself failed.
   */
  observed?: { readonly grading: FailureGrading | undefined } | undefined;
};

type CaptureRequestErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  request: Request;
};

// Keys the capture owns: the analytics envelope, the error identity and the
// failure grade. A caller's context carrying one is dropped and counted, so a
// context value can neither regroup an issue nor dodge suppression.
const RESERVED_CONTEXT_KEY = /^(?:\$|error\.|failure\.)/u;
const RESERVED_CONTEXT_NAMES: ReadonlySet<string> = new Set([
  "message",
  "severity",
  "suppressed_repeats",
]);

type AcceptedCaptureContext = {
  readonly context: ErrorTelemetryContext;
  readonly rejected: number;
};

const acceptCaptureContext = (
  context: ErrorTelemetryContext | undefined,
): AcceptedCaptureContext => {
  const accepted: ErrorTelemetryContext = {};
  let rejected = 0;
  for (const [key, value] of Object.entries(context ?? {})) {
    if (RESERVED_CONTEXT_KEY.test(key) || RESERVED_CONTEXT_NAMES.has(key)) {
      rejected += 1;
      continue;
    }
    accepted[key] = value;
  }
  return { context: accepted, rejected };
};

const SERVER_DISTINCT_ID = "server";

const CAPTURE_WINDOW_MS = 60_000;
const CAPTURE_MAX_TRACKED_KEYS = 500;

type CaptureWindow = { startedAt: number; suppressed: number };

const captureWindows = new Map<string, CaptureWindow>();

/**
 * The components of an error's structural identity, in fixed order.
 *
 * Positions are fixed and a missing component stays empty, so a frameless
 * error's cause frame can never occupy the position another error's primary
 * frame uses.
 *
 * The SQLSTATE earns its place because a database call site fails in ways
 * that are unrelated defects: a missing column and a violated check
 * constraint are raised from the same line, so they share a class, a stable
 * code, and both frames. Without the SQLSTATE they are one identity, which
 * is the opposite of what the identity is for. A wrapper class that carries
 * no `code` of its own makes this worse, because `error.code` then repeats
 * the class name and distinguishes nothing.
 */
const ERROR_IDENTITY_COMPONENTS = [
  "error.class",
  "error.code",
  "error.frame",
  "error.cause.frame",
  "error.cause.pg_code",
] as const;

/**
 * The grouping fingerprint and the suppression key are the same identity read
 * from two different places, so both derive from `ERROR_IDENTITY_COMPONENTS`
 * rather than repeating it. Listing the components twice lets one list gain a
 * component the other never gets, which silently regroups issues on one path
 * and throttles across defects on the other.
 */
const errorIdentity = (component: (key: string) => string): string =>
  ERROR_IDENTITY_COMPONENTS.map(component).join("|");

/**
 * Structural key for repeat suppression: error class, stable code, code
 * location, and SQLSTATE, deliberately excluding the caller's correlation
 * context.
 *
 * A stuck loop re-reports the same defect with a fresh request or entity ID
 * every cycle, so keying on context would defeat the throttle in exactly the
 * case that motivates it. Two call sites that genuinely share every component
 * above are the same defect.
 */
const captureWindowKey = (properties: ExceptionProperties): string =>
  errorIdentity((key) => {
    // `ExceptionProperties` widens every value to include `$exception_list`,
    // so read each field back as a string rather than stringifying whatever
    // is there.
    const value = properties[key];
    return typeof value === "string" ? value : "";
  });

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
  const fingerprint = identityFields(readEvidence(error));
  const grading =
    options.observed === undefined
      ? observeShadow({
          error,
          sink: SHADOW_SINKS.capture,
          channel: "capture",
          request: options.request,
        })
      : options.observed.grading;
  const { context, rejected } = acceptCaptureContext(options.context);
  // PostHog ingestion drops `$exception` events that lack `$exception_list`,
  // so the entry is required even though we deliberately keep it empty —
  // the redaction contract above forbids shipping the message or stack.
  // The caller's context goes first: every key after it is owned here.
  const properties: ExceptionProperties = {
    ...context,
    // PostHog groups issues from `$exception_list` content; with the message
    // and stack redacted, every event of one error class collapses into a
    // single issue and first-seen automations never fire for new defects.
    // Group by the structural fingerprint instead: same non-PII components,
    // one issue per distinct defect, read from `ERROR_IDENTITY_COMPONENTS` so
    // it stays the identity `captureWindowKey` throttles on. The production
    // server and long-running worker embed source maps, so the frames are
    // source positions rather than bundle positions; the artifact test guards
    // that build contract. Stack symbols are deliberately absent: engines can
    // infer one from a data-derived computed property key.
    $exception_fingerprint: errorIdentity((key) => fingerprint[key] ?? ""),
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
    ...safeErrorTelemetryFields(error),
    ...(options.organizationId
      ? { organization_id: options.organizationId }
      : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...shadowFields(grading),
    ...(rejected > 0 ? { "failure.ctx_rejected": String(rejected) } : {}),
  };

  // Before the throttle: dev sinks are local and unmetered, and a developer
  // reproducing a tight failure loop needs every occurrence.
  logServerDevError(error, properties);

  const suppressed = admitCapture(
    captureWindowKey(properties),
    Temporal.Now.instant().epochMilliseconds,
  );
  if (suppressed === null) {
    return;
  }

  // A failing analytics client must not turn into a failure of whatever
  // answer the caller is about to give.
  const sent = Result.try(() => {
    getServerAnalytics().capture({
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
  });
  if (Result.isError(sent)) {
    reportEmitFailure("capture", sent.error);
  }
};

export const captureError = (
  error: unknown,
  context?: ErrorTelemetryContext,
) => {
  captureErrorWithOptions(error, { context });
};

const requestCaptureOptions = (request: Request) => {
  const reqCtx = getRequestContext(request);
  return {
    request,
    distinctId: reqCtx?.posthogDistinctId,
    organizationId: reqCtx?.organizationId,
    sessionId: reqCtx?.sessionId,
  };
};

export const captureRequestError = (
  error: unknown,
  { context, request }: CaptureRequestErrorOptions,
) => {
  captureErrorWithOptions(error, {
    context,
    ...requestCaptureOptions(request),
  });
};

type CaptureObservedErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  request?: Request | undefined;
  observation: FailureGrading | undefined;
};

/**
 * Capture a failure its caller has already graded and counted, so the capture
 * neither grades it a second time nor counts it twice.
 */
export const captureObservedError = (
  error: unknown,
  { context, request, observation }: CaptureObservedErrorOptions,
) => {
  captureErrorWithOptions(error, {
    context,
    ...(request === undefined ? {} : requestCaptureOptions(request)),
    observed: { grading: observation },
  });
};

/**
 * Run a promise as fire-and-forget work, routing any rejection to
 * `captureError` instead of letting it surface as an unhandled rejection. Use
 * this only for genuinely detached work (best-effort cache warming, cleanup,
 * telemetry). When a caller needs the result or must react to failure, `await`
 * the promise or propagate it instead.
 *
 * `context` is a short, stable label identifying the call site (for example
 * `"account-cleanup.reconcile"`). Keep it a fixed string; never interpolate
 * identifiers, so it stays a safe correlation tag in telemetry.
 */
export const detached = createDetached((error, context) => {
  captureError(error, { detached: context });
});
