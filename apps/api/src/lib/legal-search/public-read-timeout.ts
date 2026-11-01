import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { HttpStatusResponse, status } from "@/api/http/status";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import {
  getPublicReadStatementTimeoutMs,
  runWithPublicReadStatementTimeout,
} from "@/api/lib/legal-search/public-read-timeout-context";
import { findRequestBudgetExpiry } from "@/api/lib/load/request-latency-budget";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";
import { publicCorpusClassOf } from "@/api/public-corpus-policy";
import type { PublicCorpusClass } from "@/api/public-corpus-policy";

export const PUBLIC_READ_TIMEOUT_CODE = "PUBLIC_READ_TIMEOUT";

/** Carry the registered route's budget through every public-law transaction. */
export const runPublicReadRequest = <T>(
  { request, route }: { request: Request; route: string },
  fn: () => T,
): T => {
  const routeClass = publicCorpusClassOf({
    method: request.method,
    path: route,
  });
  if (routeClass === undefined) {
    return fn();
  }
  return runWithPublicReadStatementTimeout(
    {
      budgetMs: (
        PUBLIC_READ_STATEMENT_TIMEOUT_MS satisfies Record<
          PublicCorpusClass,
          number
        >
      )[routeClass],
    },
    fn,
  );
};

const PUBLIC_READ_TIMEOUT_MESSAGE = "Public read timed out. Please try again.";

export const PUBLIC_READ_TIMEOUT_HINT =
  "Retry with a narrower query or a smaller selection of public-law documents.";

/** The typed, retryable 503 a public read that ran out of time answers with. */
export const publicReadTimeoutRefusal = (cause: unknown): HandlerError<503> =>
  new HandlerError({
    status: 503,
    code: PUBLIC_READ_TIMEOUT_CODE,
    message: PUBLIC_READ_TIMEOUT_MESSAGE,
    cause,
  });

/**
 * The 503 a public-law handler returns for a read that ran out of time, in
 * the body the route error mapping renders for `publicReadTimeoutRefusal`, so
 * a REST client and an MCP tool read the same answer whether the refusal was
 * returned or thrown (`publicReadTimeoutError` reads both).
 */
export const publicReadTimeoutResponse = () =>
  status(503, {
    code: PUBLIC_READ_TIMEOUT_CODE,
    message: PUBLIC_READ_TIMEOUT_MESSAGE,
    hint: PUBLIC_READ_TIMEOUT_HINT,
    retryable: true,
  });

const isPublicReadTimeoutResponse = (error: unknown): boolean =>
  error instanceof HttpStatusResponse &&
  isRecord(error.response) &&
  error.response["code"] === PUBLIC_READ_TIMEOUT_CODE;

/**
 * The refusal for a public read that ran out of time: the request's latency
 * budget ended it (a corpus index request or a public-law transaction the
 * budget clamped), an observed public-law statement was cancelled at its
 * statement budget, or a handler returned the timeout envelope for either.
 * Checked before any reading of the dependency's own failure, so an expired
 * budget never reads as the dependency being down.
 */
export const publicReadTimeoutError = (error: unknown) => {
  if (
    findRequestBudgetExpiry(error) !== undefined ||
    isPublicReadTimeoutResponse(error)
  ) {
    return publicReadTimeoutRefusal(error);
  }
  if (getPublicReadStatementTimeoutMs() === undefined) {
    return null;
  }
  const { nodes } = readEvidence(error);
  const statementIndex = nodes.findIndex((node) =>
    node.prototypes.includes(PublicLawStatementError.prototype),
  );
  if (
    statementIndex === -1 ||
    nodes.slice(statementIndex).find((node) => node.sqlState !== undefined)
      ?.sqlState !== PG_ERROR.QUERY_CANCELED
  ) {
    return null;
  }
  return publicReadTimeoutRefusal(error);
};
