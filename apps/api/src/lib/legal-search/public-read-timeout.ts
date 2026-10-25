import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  getPublicReadStatementTimeoutMs,
  runWithPublicReadStatementTimeout,
} from "@/api/lib/legal-search/public-read-timeout-context";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { publicCorpusClassOf } from "@/api/public-corpus-policy";
import type { PublicCorpusClass } from "@/api/public-corpus-policy";

export const PUBLIC_READ_TIMEOUT_CODE = "PUBLIC_READ_TIMEOUT";

/** Carry the registered route's budget through every public-law transaction. */
export const runPublicReadRequest = <T>(
  { request, route }: { request: Request; route: string },
  fn: () => T,
): T => {
  const routeClass = publicCorpusClassOf(
    { method: request.method, path: route },
    new URL(request.url),
  );
  if (routeClass === undefined) {
    return fn();
  }
  return runWithPublicReadStatementTimeout(
    (
      PUBLIC_READ_STATEMENT_TIMEOUT_MS satisfies Record<
        PublicCorpusClass,
        number
      >
    )[routeClass],
    fn,
  );
};

/** SQLSTATE survives query and Result wrappers; SQL diagnostics stay server-side. */
export const publicReadTimeoutError = (error: unknown) => {
  if (
    getPublicReadStatementTimeoutMs() === undefined ||
    getPgErrorCode(error) !== PG_ERROR.QUERY_CANCELED
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
