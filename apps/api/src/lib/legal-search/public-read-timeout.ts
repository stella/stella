import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import {
  getPublicReadStatementTimeoutMs,
  runWithPublicReadStatementTimeout,
} from "@/api/lib/legal-search/public-read-timeout-context";
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

/** Only observed public-law statements carry the provenance for this refusal. */
export const publicReadTimeoutError = (error: unknown) => {
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
  return new HandlerError({
    status: 503,
    code: PUBLIC_READ_TIMEOUT_CODE,
    message: "Public read timed out. Please try again.",
    cause: error,
  });
};
