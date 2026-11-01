import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import {
  getPublicReadStatementTimeoutMs,
  runWithPublicReadStatementTimeout,
} from "@/api/lib/legal-search/public-read-timeout-context";
import { findRequestBudgetExpiry } from "@/api/lib/load/request-latency-budget";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { PG_ERROR } from "@/api/lib/pg-error";
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

/** The typed, retryable 503 a public read that ran out of time answers with. */
export const publicReadTimeoutRefusal = (cause: unknown): HandlerError<503> =>
  new HandlerError({
    status: 503,
    code: PUBLIC_READ_TIMEOUT_CODE,
    message: "Public read timed out. Please try again.",
    cause,
  });

/**
 * The refusal for a public read that ran out of time: the request's latency
 * budget ended it (a corpus index request or a public-law transaction the
 * budget clamped), or an observed public-law statement was cancelled at its
 * statement budget. Checked before any reading of the dependency's own
 * failure, so an expired budget never reads as the dependency being down.
 */
export const publicReadTimeoutError = (error: unknown) => {
  if (findRequestBudgetExpiry(error) !== undefined) {
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
