/**
 * The request lifecycle's failure and completion records, as the server's
 * `onError` and `onAfterHandle` hooks.
 *
 * Split out of `server.ts` so one test can drive the whole HTTP lifecycle
 * (handler, error hook, completion hook) through a real Elysia app and read
 * every record and response it produces, without starting the server.
 */

import type { Context } from "elysia";

import { captureObservedError } from "@/api/lib/analytics/capture";
import { getServerAnalytics } from "@/api/lib/analytics/client";
import {
  currentQueryCount,
  DB_QUERY_COUNT_HEADER,
} from "@/api/lib/db-query-counter";
import {
  elysiaErrorAnswer,
  elysiaFailureReason,
} from "@/api/lib/errors/elysia-error";
import { httpError } from "@/api/lib/errors/http-error";
import { errorTag } from "@/api/lib/errors/utils";
import { identityFields } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  legacyChannelOf,
  observeShadow,
  observeUnobserved5xx,
  SHADOW_SINKS,
} from "@/api/lib/observability/failure-shadow";
import { logger } from "@/api/lib/observability/logger";
import {
  getRequestContext,
  getRequestFailure,
  isAiRequest,
} from "@/api/lib/observability/request-context";
import { emitRequestDurationMetric } from "@/api/lib/observability/request-metrics";
import { resolveResponseStatus } from "@/api/lib/observability/response-status";
import { isLocalDevOpen } from "@/api/runtime-mode";

const HEALTH_PATHS = new Set(["/health", "/live", "/ready", "/started"]);
// Emit the per-request query count in local development only, so the e2e
// guard can assert per-route budgets without other processes paying any
// per-query cost. Must match the logger gate in db/root.ts.
const DB_QUERY_COUNTER_ENABLED = isLocalDevOpen();

const getRequestPath = (request: Request): string =>
  new URL(request.url).pathname;

// Stamp the per-request query count onto the outgoing response. Reads the
// active counter store, so it is a no-op when the store was never started
// (production, or a request that bypassed `onRequest`).
const setDbQueryCountHeader = (set: Context["set"]) => {
  if (!DB_QUERY_COUNTER_ENABLED) {
    return;
  }
  const queryCount = currentQueryCount();
  if (queryCount === undefined) {
    return;
  }
  set.headers[DB_QUERY_COUNT_HEADER] = String(queryCount);
};

const shouldLogRequest = (path: string): boolean => !HEALTH_PATHS.has(path);

const getRouteName = (route: string | undefined): string =>
  route ?? "unmatched";

const buildRequestLogDetails = ({
  durationMs,
  errorType,
  request,
  route,
  statusCode,
  reqCtx,
  elysiaCode,
}: {
  durationMs: number;
  errorType?: string;
  request: Request;
  route?: string | undefined;
  statusCode: number;
  reqCtx?: ReturnType<typeof getRequestContext>;
  elysiaCode?: string;
}) => {
  const details = {
    durationMs: Math.round(durationMs),
    method: request.method,
    route,
    statusCode,
  };

  if (elysiaCode) {
    Object.assign(details, { elysiaCode });
  }

  if (errorType) {
    Object.assign(details, { errorType });
  }

  if (reqCtx?.requestId) {
    Object.assign(details, { requestId: reqCtx.requestId });
  }

  if (reqCtx?.clientAddressSource) {
    Object.assign(details, {
      clientAddressSource: reqCtx.clientAddressSource,
    });
  }

  return details;
};

type RequestErrorContext = {
  error: unknown;
  set: Context["set"];
  code: number | string;
  request: Request;
  route: string | undefined;
};

/** The server's `onError` hook: the framework-level failure record and answer. */
export const answerRequestError = ({
  error,
  set,
  code,
  request,
  route,
}: RequestErrorContext) => {
  delete set.headers["X-Powered-By"];
  setDbQueryCountHeader(set);

  const path = getRequestPath(request);
  const reqCtx = getRequestContext(request);
  const { status: statusCode, message: errorMessage } = elysiaErrorAnswer(
    code,
    error,
  );
  const logged = shouldLogRequest(path);
  const captured = statusCode >= 500;
  const loggedSeverity = captured ? "ERROR" : "WARN";
  const grading = observeShadow({
    error,
    sink: SHADOW_SINKS.framework,
    channel: legacyChannelOf({
      severity: logged ? loggedSeverity : undefined,
      capture: captured,
    }),
    request,
    requestState: {
      answeredStatus: statusCode,
      framework: elysiaFailureReason(code, error),
    },
  });

  if (logged) {
    const durationMs = reqCtx ? performance.now() - reqCtx.startTime : 0;
    const details = buildRequestLogDetails({
      durationMs,
      errorType: errorTag(error),
      request,
      route,
      statusCode,
      reqCtx,
      elysiaCode: String(code),
    });

    if (statusCode >= 500) {
      logger.request({
        ...details,
        errorFingerprint: identityFields(readEvidence(error)),
        failure: grading,
        message: "request.failed",
        severity: "ERROR",
      });
    } else {
      logger.request({
        ...details,
        failure: grading,
        message: "request.failed",
        severity: "WARN",
      });
    }

    emitRequestDurationMetric({
      durationMs,
      requestClass: isAiRequest() ? "ai" : "crud",
      statusCode,
      route: getRouteName(route),
    });
  }

  // A framework-answered client fault (a rejected body, an unknown route,
  // an unparseable request) is the caller's own outcome: the WARN record
  // above keeps it, and reporting it as an exception would fill the tracker
  // with one issue per scanner probe and schema mismatch. A response-schema
  // violation shares the VALIDATION code but is the handler's own fault, so
  // it stays captured along with every other code.
  if (captured) {
    captureObservedError(error, {
      request,
      context: {
        route: getRouteName(route),
        method: request.method,
        elysiaCode: String(code),
      },
      observation: grading,
    });
  }

  // Return a sanitized response for unhandled errors.
  // Elysia's default would serialize error.message, which
  // may contain DB internals, file names, or document content.
  set.status = statusCode;
  return httpError(errorMessage);
};

type RequestCompletionContext = {
  request: Request;
  responseValue: unknown;
  route: string | undefined;
  set: Context["set"];
};

// The completion record grades its answer by the failure the request
// observed. A 5xx with none observed (a handler that returned the status
// itself) is counted as such, at the severity it always had.
const completionFailure = (request: Request, statusCode: number) =>
  getRequestFailure(request) ??
  (statusCode >= 500 ? observeUnobserved5xx() : undefined);

/** The server's `onAfterHandle` hook: the completion record and flush. */
export const completeRequest = async ({
  request,
  responseValue,
  route,
  set,
}: RequestCompletionContext) => {
  delete set.headers["X-Powered-By"];
  setDbQueryCountHeader(set);

  const path = getRequestPath(request);
  const reqCtx = getRequestContext(request);

  if (shouldLogRequest(path) && reqCtx) {
    const durationMs = performance.now() - reqCtx.startTime;
    const statusCode = resolveResponseStatus({
      response: responseValue,
      set,
    });
    const details = buildRequestLogDetails({
      durationMs,
      request,
      route,
      statusCode,
      reqCtx,
    });
    const failure =
      statusCode >= 400 ? completionFailure(request, statusCode) : undefined;

    if (statusCode >= 500) {
      logger.request({
        ...details,
        failure,
        message: "request.completed",
        severity: "ERROR",
      });
    } else if (statusCode >= 400) {
      logger.request({
        ...details,
        failure,
        message: "request.completed",
        severity: "WARN",
      });
    } else {
      logger.request({
        ...details,
        message: "request.completed",
        severity: "INFO",
      });
    }

    // Streaming responses (e.g. POST /v1/chat) settle this hook when the
    // stream object is returned, not when generation ends, so their
    // duration here understates the wall-clock. That is acceptable: the
    // class is `ai` either way, which is excluded from the CRUD p95 SLO.
    emitRequestDurationMetric({
      durationMs,
      requestClass: isAiRequest() ? "ai" : "crud",
      statusCode,
      route: getRouteName(route),
    });
  }

  if (!isLocalDevOpen() && shouldLogRequest(path)) {
    await flushAnalytics(route);
  }
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
