/**
 * The request lifecycle's failure and completion records, as two pipeline
 * stages: `errorBoundary` answers every failure the pipeline throws, and
 * `requestCompletion` writes each request's one log record and duration
 * metric from its final answer.
 */
import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";
import {
  classifyFailure,
  failureGradeOf,
  sanitizeErrorAttributesForOutput,
} from "@stll/errors";
import type { FailureGrade, FailureReason } from "@stll/errors";

import type { RequestContext } from "@/api/http/context";
import { setResponseHeaders } from "@/api/http/headers";
import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { status } from "@/api/http/status";
import { captureObservedError } from "@/api/lib/analytics/capture";
import { getServerAnalytics } from "@/api/lib/analytics/client";
import {
  currentQueryCount,
  currentTransactionCount,
  DB_QUERY_COUNT_HEADER,
  DB_TRANSACTION_COUNT_HEADER,
} from "@/api/lib/db-query-counter";
import {
  httpFailureAnswer,
  httpFailureBody,
} from "@/api/lib/errors/http-failure-answer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import type { FailureGrading } from "@/api/lib/observability/failure";
import { failureSink, identityFields } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { failureOutputPolicy } from "@/api/lib/observability/failure-output-policy";
import {
  countFailureObservation,
  legacyChannelOf,
  observeShadow,
  SHADOW_SINKS,
} from "@/api/lib/observability/failure-shadow";
import { observeLimiterAdmissionFailure } from "@/api/lib/observability/limiter-admission-failure";
import { logger } from "@/api/lib/observability/logger";
import { NO_ERROR_IDENTITY } from "@/api/lib/observability/release-failures";
import {
  claimRequestRecord,
  getMountedRequestRoute,
  getRequestContext,
  getRequestFailure,
  recordRequestExceptionScope,
} from "@/api/lib/observability/request-context";
import { emitRequestDurationMetric } from "@/api/lib/observability/request-metrics";
import { requestClassAtCompletion } from "@/api/lib/observability/route-latency-class";
import { isLocalDevOpen } from "@/api/runtime-mode";

const HEALTH_PATHS = new Set(["/health", "/live", "/ready", "/started"]);
// Emit the per-request query count in local development only, so the e2e
// guard can assert per-route budgets without other processes paying any
// per-query cost. Must match the logger gate in db/root.ts.
const DB_QUERY_COUNTER_ENABLED = isLocalDevOpen();

const shouldLogRequest = (path: string): boolean => !HEALTH_PATHS.has(path);

const getRouteName = (route: string | undefined): string =>
  (route === undefined || route.includes("*")
    ? (getMountedRequestRoute() ?? route)
    : route) ?? "unmatched";

const buildRequestLogDetails = ({
  durationMs,
  errorType,
  request,
  route,
  statusCode,
  failureKind,
}: {
  durationMs: number;
  errorType?: string;
  request: Request;
  route: string | undefined;
  statusCode: number;
  failureKind?: string;
}) => {
  const reqCtx = getRequestContext();
  return {
    durationMs: Math.round(durationMs),
    method: request.method,
    route: getRouteName(route),
    statusCode,
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(reqCtx?.requestId === undefined ? {} : { requestId: reqCtx.requestId }),
    ...(reqCtx?.clientAddressSource
      ? { clientAddressSource: reqCtx.clientAddressSource }
      : {}),
  };
};

const elapsedMs = (): number => {
  const reqCtx = getRequestContext();
  return reqCtx === undefined ? 0 : performance.now() - reqCtx.startTime;
};

/**
 * The failure record and sanitized answer for an error the pipeline threw.
 * Pipeline failures the caller caused (a rejected body, an unknown route, an
 * unparseable request) are logged as WARN and never reach the exception
 * tracker, which would otherwise fill with one issue per scanner probe; an
 * internal error and an answer that broke its own schema are captured.
 */
const answerRequestError = (error: unknown, ctx: RequestContext): Response => {
  const answer = httpFailureAnswer(error);
  const statusCode = answer.status;
  const logged = shouldLogRequest(ctx.path);
  const captured = statusCode >= 500;
  const routeName = getRouteName(ctx.route);
  const failedSeverity = captured ? "ERROR" : "WARN";
  const scope = {
    type: "request",
    method: ctx.request.method,
    routeTemplate: routeName,
  } as const;
  recordRequestExceptionScope(ctx.request, scope);
  if (answer.code === LIMITER_STORE_UNAVAILABLE.code) {
    observeLimiterAdmissionFailure(error, "limiter");
    if (claimRequestRecord()) {
      emitRequestDurationMetric({
        durationMs: elapsedMs(),
        requestClass: requestClassAtCompletion({
          method: ctx.request.method,
          route: routeName,
        }),
        statusCode,
        route: routeName,
      });
    }
    return toResponse(status(statusCode, httpFailureBody(answer)), ctx.set);
  }
  const grading = observeShadow({
    error,
    sink: SHADOW_SINKS.framework,
    channel: legacyChannelOf({
      severity: logged ? failedSeverity : undefined,
      capture: captured,
    }),
    request: ctx.request,
    route: routeName,
    requestState: {
      answeredStatus: statusCode,
      framework: answer.framework,
    },
  });

  if (logged && claimRequestRecord()) {
    const durationMs = elapsedMs();
    const attributes = sanitizeErrorAttributesForOutput({
      ...buildRequestLogDetails({
        durationMs,
        errorType: errorTag(error),
        request: ctx.request,
        route: ctx.route,
        statusCode,
        ...(answer.framework === undefined
          ? {}
          : { failureKind: answer.framework }),
      }),
      ...(captured
        ? { errorFingerprint: identityFields(readEvidence(error)) }
        : {}),
      failure: grading,
      message: "request.failed",
      severity: failedSeverity,
    });
    logger.request({
      durationMs: 0,
      method: "",
      statusCode: 500,
      message: "request.failed" as const,
      severity: "ERROR" as const,
      ...attributes,
    });
    emitRequestDurationMetric({
      durationMs,
      requestClass: requestClassAtCompletion({
        method: ctx.request.method,
        route: routeName,
      }),
      statusCode,
      route: routeName,
    });
  }

  if (captured) {
    captureObservedError(error, {
      scope,
      fingerprintKey: "observability.answerRequestError",
      request: ctx.request,
      context: {
        route: routeName,
        method: ctx.request.method,
        ...(answer.framework === undefined
          ? {}
          : { failureKind: answer.framework }),
      },
      observation: grading,
    });
  }

  if (answer.allow !== undefined) {
    ctx.set.headers["Allow"] = answer.allow.join(", ");
  }
  return toResponse(status(statusCode, httpFailureBody(answer)), ctx.set);
};

/** Answers every failure thrown by the stages and route inside it. */
export const errorBoundary: Middleware = async (ctx, inner) => {
  try {
    return await inner();
  } catch (error) {
    return answerRequestError(error, ctx);
  }
};

const COMPLETION_SINK = failureSink({
  event: "request.completed",
  expected: [],
});

// A 5xx answered with no failure observed on the way to it: built outside the
// answer owners (`server-error-answer.ts`), so its cause was never recorded.
const UNOBSERVED_5XX_GRADING = {
  grade: failureGradeOf("unobserved_5xx"),
  reason: "unobserved_5xx",
  rule: "unobserved",
  evidenceDepth: 0,
} as const satisfies FailureGrading;

const UNOBSERVED_5XX_POLICY = failureOutputPolicy(UNOBSERVED_5XX_GRADING.grade);

type CompletionFailure = {
  readonly grade: FailureGrade;
  readonly reason: FailureReason;
  /** Set when the record follows the grade's policy instead of shadowing it. */
  readonly policy?: "grade";
};

/**
 * Grade a 5xx no observation accounts for by the owner's policy rather than
 * in shadow: the record takes the grade's severity, and the answer is
 * captured, so the gap reports itself with its route and request id.
 */
const observeUnobserved5xx = (
  request: Request,
  route: string,
  statusCode: number,
): CompletionFailure => {
  countFailureObservation({
    sink: COMPLETION_SINK,
    grading: UNOBSERVED_5XX_GRADING,
    channel: legacyChannelOf(UNOBSERVED_5XX_POLICY),
    degradation: undefined,
    route,
    identity: NO_ERROR_IDENTITY,
  });
  if (UNOBSERVED_5XX_POLICY.capture) {
    captureObservedError(
      classifyFailure(
        new HandlerError({
          status: 500,
          message: "A server error answer was built without its cause",
        }),
        UNOBSERVED_5XX_GRADING.reason,
      ),
      {
        scope: {
          type: "request",
          method: request.method,
          routeTemplate: route,
        },
        fingerprintKey: "observability.unobservedServerError",
        request,
        context: {
          route,
          method: request.method,
          statusCode: String(statusCode),
        },
        observation: UNOBSERVED_5XX_GRADING,
      },
    );
  }
  return { ...UNOBSERVED_5XX_GRADING, policy: "grade" };
};

// The completion record grades its answer by the failure the request
// observed, or, for a 5xx with none, as an unobserved 5xx.
const completionFailure = (
  request: Request,
  statusCode: number,
  route: string | undefined,
): CompletionFailure | undefined =>
  getRequestFailure() ??
  (statusCode >= 500
    ? observeUnobserved5xx(request, getRouteName(route), statusCode)
    : undefined);

type CompletionSeverity = "ERROR" | "WARN" | "INFO";

const severityFor = (
  statusCode: number,
  failure: CompletionFailure | undefined,
): CompletionSeverity => {
  if (failure?.policy === "grade") {
    return failureOutputPolicy(failure.grade).severity;
  }
  if (statusCode >= 500) {
    return "ERROR";
  }
  return statusCode >= 400 ? "WARN" : "INFO";
};

/**
 * Flush queued analytics after a request. A flush failure is logged, never
 * captured: capturing it would queue another event on the client whose flush
 * just failed, and feed the failure back into itself.
 */
export const flushAnalytics = async (route: string | undefined) => {
  await getServerAnalytics()
    .flush()
    .catch((error: unknown) => {
      logger.error("analytics.flush.failed", {
        "error.type": errorTag(error),
        "http.route": getRouteName(route),
      });
    });
};

/**
 * Each request's completion record, from its final answer: the one log line
 * and duration metric (unless the error boundary already wrote them), the
 * development query-count header, and the analytics flush.
 *
 * A streaming answer (`POST /v1/chat`) completes when its stream is handed
 * back, not when generation ends, so its duration understates the wall-clock.
 * That is intended: the declared stream class keeps setup time out of the CRUD
 * p95 SLO even when no model has started yet.
 */
export const requestCompletion: Middleware = async (ctx, inner) => {
  const answered = await inner();
  const queryCount = DB_QUERY_COUNTER_ENABLED ? currentQueryCount() : undefined;
  const transactionCount = currentTransactionCount();
  const response =
    queryCount === undefined && transactionCount === undefined
      ? answered
      : setResponseHeaders(
          answered,
          {
            ...(queryCount === undefined
              ? {}
              : { [DB_QUERY_COUNT_HEADER]: String(queryCount) }),
            ...(transactionCount === undefined
              ? {}
              : { [DB_TRANSACTION_COUNT_HEADER]: String(transactionCount) }),
          },
          { overwrite: true },
        );

  if (shouldLogRequest(ctx.path) && claimRequestRecord()) {
    const durationMs = elapsedMs();
    const statusCode = response.status;
    const failure =
      statusCode >= 400
        ? completionFailure(ctx.request, statusCode, ctx.route)
        : undefined;
    if (failure?.reason !== "limiter_store_unavailable") {
      logger.request({
        ...buildRequestLogDetails({
          durationMs,
          request: ctx.request,
          route: ctx.route,
          statusCode,
        }),
        ...(failure === undefined ? {} : { failure }),
        message: "request.completed",
        severity: severityFor(statusCode, failure),
      });
    }
    emitRequestDurationMetric({
      durationMs,
      requestClass: requestClassAtCompletion({
        method: ctx.request.method,
        route: getRouteName(ctx.route),
      }),
      statusCode,
      route: getRouteName(ctx.route),
    });
  }

  if (!isLocalDevOpen() && shouldLogRequest(ctx.path)) {
    await flushAnalytics(ctx.route);
  }
  return response;
};
