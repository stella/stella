import { Result } from "better-result";

import { createDetached } from "@stll/errors";
import type { FailureGrade, FailureReason } from "@stll/errors";
import { Temporal } from "@stll/time";

import { getServerAnalytics } from "@/api/lib/analytics/client";
import type { ExceptionProperties } from "@/api/lib/analytics/server-analytics";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import { sanitizeDiagnosticErrorForOutput } from "@/api/lib/errors/handoff-diagnostics";
import {
  errorTag,
  logServerDevError,
  safeErrorTelemetryFields,
} from "@/api/lib/errors/utils";
import type { FailureGrading } from "@/api/lib/observability/failure";
import {
  identityFields,
  providerStatusFieldsOf,
  requestErrorStatusFields,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { failureOutputPolicy } from "@/api/lib/observability/failure-output-policy";
import {
  observeShadow,
  reportEmitFailure,
  SHADOW_SINKS,
  shadowFields,
} from "@/api/lib/observability/failure-shadow";
import { providerErrorFields } from "@/api/lib/observability/provider-error-reason";
import { getRequestContext } from "@/api/lib/observability/request-context";

/**
 * Capture an error for observability.
 *
 * - Dev: query values redacted before logging to `console.error` and
 *   appending to
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

declare const exceptionClassBrand: unique symbol;
type ExceptionClass = string & { readonly [exceptionClassBrand]: true };
declare const exceptionCodeBrand: unique symbol;
type ExceptionCode = string & { readonly [exceptionCodeBrand]: true };
declare const exceptionFrameBrand: unique symbol;
type ExceptionFrame = string & { readonly [exceptionFrameBrand]: true };

type ExceptionValueFields = {
  className: ExceptionClass | "UnknownError";
  code?: ExceptionCode;
  status?: number;
  reason?: FailureReason;
  grade?: FailureGrade;
  frame?: ExceptionFrame;
};

/** Renders only structural fields that have already crossed their allowlist. */
const exceptionValue = ({
  className,
  code,
  status,
  reason,
  grade,
  frame,
}: ExceptionValueFields): string => {
  const distinctReason =
    reason !== undefined && reason !== code ? reason : undefined;
  return `${className}${code === undefined ? "" : `[${code}]`}${
    status === undefined ? "" : ` ${status}`
  }${distinctReason === undefined ? "" : ` ${distinctReason}`}${
    grade === undefined ? "" : ` ${grade}`
  }${frame === undefined ? "" : ` at ${frame}`}`;
};

const CLASS_TOKEN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const CODE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;
// The checkout root differs per host (container, CI runner, laptop) and may
// carry a user name, so only the repository-relative suffix is kept.
const REPOSITORY_FRAME =
  /(?:^|\/)((?:apps|packages)\/[A-Za-z0-9_./-]+:\d+(?::\d+)?)$/u;
const REPOSITORY_FRAME_SUFFIX =
  /^(?:apps|packages)\/[A-Za-z0-9_./-]+:\d+(?::\d+)?$/u;

// The allowlists narrow by predicate, so a branded value only ever comes from
// a string that passed its pattern.
const isExceptionClass = (value: string): value is ExceptionClass =>
  CLASS_TOKEN.test(value);

const isExceptionCode = (value: string): value is ExceptionCode =>
  CODE_TOKEN.test(value);

const isExceptionFrame = (value: string): value is ExceptionFrame =>
  REPOSITORY_FRAME_SUFFIX.test(value);

const UNKNOWN_EXCEPTION_CLASS = "UnknownError";

const exceptionClass = (
  value: string,
): ExceptionClass | typeof UNKNOWN_EXCEPTION_CLASS =>
  // `errorTag` normally supplies a class token; keep a fixed fallback if a
  // foreign Error overrides its name with free text.
  isExceptionClass(value) ? value : UNKNOWN_EXCEPTION_CLASS;

const exceptionCode = (value: string | undefined): ExceptionCode | undefined =>
  value !== undefined && isExceptionCode(value) ? value : undefined;

const exceptionFrame = (
  value: string | undefined,
): ExceptionFrame | undefined => {
  const repositoryFrame =
    value === undefined ? undefined : REPOSITORY_FRAME.exec(value)?.at(1);
  return repositoryFrame !== undefined && isExceptionFrame(repositoryFrame)
    ? repositoryFrame
    : undefined;
};

/**
 * The grouping fingerprint and the suppression key are the same identity read
 * from two different places, so both derive from `ERROR_IDENTITY_COMPONENTS`
 * rather than repeating it. Listing the components twice lets one list gain a
 * component the other never gets, which silently regroups issues on one path
 * and throttles across defects on the other.
 */
const errorIdentity = (fields: Readonly<Record<string, unknown>>): string =>
  [
    ...ERROR_IDENTITY_COMPONENTS.map((key) => fields[key]),
    ...(fields["error.provider.status"] === undefined
      ? []
      : [
          fields["error.provider.code"] ?? fields["error.provider.type"],
          fields["error.provider.status"],
        ]),
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join("|");

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
  errorIdentity(properties);

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
  const evidence = readEvidence(error);
  const fingerprint = identityFields(evidence);
  const grading =
    options.observed === undefined
      ? observeShadow({
          error,
          sink: SHADOW_SINKS.capture,
          channel: "capture",
          request: options.request,
        })
      : options.observed.grading;
  const safeOutput = sanitizeDiagnosticErrorForOutput({
    error,
    context: options.context,
  });
  const safeEnvelope =
    safeOutput !== null &&
    typeof safeOutput === "object" &&
    "error" in safeOutput
      ? safeOutput
      : undefined;
  const safeError =
    safeEnvelope === undefined ? safeOutput : safeEnvelope.error;
  const contextValue =
    safeEnvelope !== undefined && "context" in safeEnvelope
      ? safeEnvelope.context
      : undefined;
  const safeContext =
    contextValue !== null &&
    typeof contextValue === "object" &&
    !Array.isArray(contextValue)
      ? Object.fromEntries(
          Object.entries(contextValue).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const { context, rejected } = acceptCaptureContext(safeContext);
  // A provider error an adapter forwards as a plain object has no class, code
  // or frame of its own, so its provider status and body code are the only
  // structural fields that tell one refused request from another. Read only
  // at the root: there the provider status shows the root is a provider error.
  const rootProviderStatus = evidence.nodes.at(0)?.providerStatus?.status;
  const providerFields =
    rootProviderStatus === undefined ? {} : providerErrorFields(error);
  const providerStatusFields = providerStatusFieldsOf(evidence);
  const status =
    requestErrorStatusFields(evidence)["error.status_code"] ??
    rootProviderStatus;
  const className = exceptionClass(tag);
  // The identity fills a missing code with the class tag; that echo is no
  // code. Compared before branding: the two brands never overlap.
  const ownCode = fingerprint["error.code"];
  const code = exceptionCode(
    ownCode === undefined || ownCode === tag
      ? (providerFields["error.provider.code"] ??
          providerFields["error.provider.type"])
      : ownCode,
  );
  const frame = exceptionFrame(fingerprint["error.frame"]);
  const value = exceptionValue({
    className,
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(grading === undefined
      ? {}
      : { reason: grading.reason, grade: grading.grade }),
    ...(frame === undefined ? {} : { frame }),
  });
  // PostHog ingestion drops `$exception` events that lack `$exception_list`,
  // so the entry is required. Its value is built only from typed structural
  // fields; the redaction contract above forbids the message and stack.
  // The caller's context goes first: every key after it is owned here.
  const properties: ExceptionProperties = {
    ...context,
    // PostHog groups issues from `$exception_list` content; with the message
    // and stack redacted, every event of one error class collapses into a
    // single issue and first-seen automations never fire for new defects.
    // Group by the structural fingerprint instead: same non-PII components,
    // one issue per distinct defect, read from `ERROR_IDENTITY_COMPONENTS` so
    // it stays the identity `captureWindowKey` throttles on. The production
    // server and long-running worker ship source maps, so the frames are
    // source positions rather than bundle positions; the artifact test guards
    // that build contract. Stack symbols are deliberately absent: engines can
    // infer one from a data-derived computed property key.
    $exception_fingerprint: errorIdentity({
      ...fingerprint,
      ...providerStatusFields,
      ...providerFields,
    }),
    $exception_level: "error",
    $exception_list: [
      {
        mechanism: { handled: true, synthetic: false, type: "generic" },
        type: tag,
        value,
      },
    ],
    $exception_type: tag,
    // Non-PII structural fingerprint (class, stable code, top
    // `file:line:col` frames). The redaction contract above still
    // forbids the message and stack; a code location and class name
    // carry no client data, so they make the exception actionable in
    // the dashboard without violating it.
    ...fingerprint,
    ...providerStatusFields,
    ...providerFields,
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
  logServerDevError(safeError, properties);

  if (grading !== undefined && !failureOutputPolicy(grading.grade).capture) {
    return;
  }

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
  const reqCtx = getRequestContext();
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
