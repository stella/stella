/**
 * The failure emitter: one call observes a failure, and the owner decides the
 * record, its severity, whether it is captured, and what it counts.
 *
 * A sink passes a handle, never a severity. The handle's `legacy` pin keeps a
 * migrated site's output exactly as it was until data backs a change; without
 * one, the grade's policy decides. The record is composed here, owned fields
 * last, so a context key can override neither the grade nor the identity.
 *
 * Returns nothing: retry, park and exit decisions keep their own predicates.
 */

import { Result } from "better-result";

import type { FailureGrade } from "@stll/errors";

import { captureObservedError } from "@/api/lib/analytics/capture";
import type {
  FailureGrading,
  FailureSink,
  OutputPolicy,
} from "@/api/lib/observability/failure";
import {
  errorFields,
  failureFields,
  fingerprintDegradation,
  gradeFailure,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  countFailureObservation,
  legacyChannelOf,
  reportEmitFailure,
} from "@/api/lib/observability/failure-shadow";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import { logger } from "@/api/lib/observability/logger";
import {
  getRequestContext,
  recordRequestFailure,
} from "@/api/lib/observability/request-context";
import { emitFailureMetric } from "@/api/lib/observability/request-metrics";

type GradePolicy = OutputPolicy & {
  /** A sustained episode, as a queue adapter judges it, raises the severity. */
  readonly escalation?: "sustained";
};

const GRADE_POLICY = {
  anticipated: { severity: "WARN", capture: false },
  transient: { severity: "WARN", capture: false, escalation: "sustained" },
  client: { severity: "WARN", capture: false },
  defect: { severity: "ERROR", capture: true },
} as const satisfies Record<FailureGrade, GradePolicy>;

/**
 * Context keys a failure record may carry: correlation ids and reviewed,
 * bounded domain metadata. Closed, so a caller cannot attach a value the
 * review never saw; the lint rule and the type hold call sites to it, and the
 * runtime drops anything else and counts it.
 */
export const FAILURE_CONTEXT_KEYS = [
  "adapterKey",
  "decisionId",
  "documentId",
  "entityId",
  "feature",
  "jobId",
  "method",
  "mode",
  "modelId",
  "operation",
  "organizationId",
  "phase",
  "queue",
  "requestId",
  "route",
  "runId",
  "source",
  "stage",
  "step",
  "threadId",
  "toolName",
  "userFileId",
  "versionId",
  "workspaceId",
] as const;

type FailureContextKey = (typeof FAILURE_CONTEXT_KEYS)[number];

type FailureContext = Partial<Record<FailureContextKey, string>>;

const MAX_CONTEXT_VALUE_LENGTH = 128;

const FAILURE_CONTEXT_KEY_SET: ReadonlySet<string> = new Set(
  FAILURE_CONTEXT_KEYS,
);

type AcceptedContext = {
  readonly accepted: Record<string, string>;
  readonly rejected: number;
};

const acceptFailureContext = (
  ctx: Readonly<Record<string, unknown>> | undefined,
): AcceptedContext => {
  const accepted: Record<string, string> = {};
  let rejected = 0;
  for (const [key, value] of Object.entries(ctx ?? {})) {
    if (
      FAILURE_CONTEXT_KEY_SET.has(key) &&
      typeof value === "string" &&
      value.length <= MAX_CONTEXT_VALUE_LENGTH
    ) {
      accepted[key] = value;
    } else {
      rejected += 1;
    }
  }
  return { accepted, rejected };
};

type ResolvedPolicy = OutputPolicy & { readonly source: "grade" | "legacy" };

const resolvePolicy = (
  sink: FailureSink,
  grade: FailureGrade,
  escalation: "sustained" | undefined,
): ResolvedPolicy => {
  if (sink.legacy !== undefined) {
    return { ...sink.legacy, source: "legacy" };
  }
  const policy: GradePolicy = GRADE_POLICY[grade];
  const escalated =
    escalation !== undefined && policy.escalation === escalation;
  return {
    severity: escalated ? "ERROR" : policy.severity,
    capture: policy.capture,
    source: "grade",
  };
};

type ObserveFailureOptions = {
  readonly sink: FailureSink;
  readonly ctx?: FailureContext | undefined;
  readonly request?: Request | undefined;
  readonly escalation?: "sustained" | undefined;
};

const requestFields = (request: Request | undefined): LoggerAttributes => {
  const requestId =
    request === undefined ? undefined : getRequestContext(request)?.requestId;
  return requestId === undefined ? {} : { "request.id": requestId };
};

const observe = (
  error: unknown,
  { sink, ctx, request, escalation }: ObserveFailureOptions,
): void => {
  const evidence = readEvidence(error);
  const grading: FailureGrading = gradeFailure(evidence, sink, {
    requestAborted: request?.signal.aborted,
  });
  const policy = resolvePolicy(sink, grading.grade, escalation);
  const context = acceptFailureContext(ctx);
  const attributes: LoggerAttributes = {
    ...context.accepted,
    ...requestFields(request),
    ...errorFields(evidence),
    ...failureFields(grading, sink),
    "failure.policy": policy.source,
    ...(context.rejected > 0
      ? { "failure.ctx_rejected": context.rejected }
      : {}),
  };

  if (request !== undefined) {
    recordRequestFailure(request, {
      grade: grading.grade,
      reason: grading.reason,
      sink: sink.event,
    });
    if (grading.grade === "transient") {
      emitFailureMetric({ sink: sink.event, reason: grading.reason });
    }
  }
  countFailureObservation({
    sink,
    grading,
    channel: legacyChannelOf(policy),
    degradation: fingerprintDegradation(evidence),
  });

  if (policy.severity === "ERROR") {
    logger.error(sink.event, attributes);
  } else {
    logger.warn(sink.event, attributes);
  }
  if (policy.capture) {
    captureObservedError(error, {
      context: context.accepted,
      request,
      observation: grading,
    });
  }
};

/**
 * Observe one failure through its sink handle. Never throws: a failure while
 * observing is reported through the plain logger and the caller carries on
 * with its own answer.
 */
export const observeFailure = (
  error: unknown,
  options: ObserveFailureOptions,
): void => {
  const observed = Result.try(() => {
    observe(error, options);
  });
  if (Result.isError(observed)) {
    reportEmitFailure("observe", observed.error);
  }
};
