import { AsyncLocalStorage } from "node:async_hooks";

import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { resolvePublicCorpusPolicy } from "@/api/public-corpus-policy";

const publicReadTimeout = new AsyncLocalStorage<number>();

export const PUBLIC_READ_TIMEOUT_CODE = "PUBLIC_READ_TIMEOUT";

export const getPublicReadStatementTimeoutMs = () =>
  publicReadTimeout.getStore();

/** Carry the registered route's budget through every public-law transaction. */
export const runPublicReadRequest = <T>(request: Request, fn: () => T): T => {
  const policy = resolvePublicCorpusPolicy(request);
  if (policy === undefined) {
    return fn();
  }
  return publicReadTimeout.run(
    PUBLIC_READ_STATEMENT_TIMEOUT_MS[policy.class],
    fn,
  );
};

/** SQLSTATE survives query and Result wrappers; SQL diagnostics stay server-side. */
export const publicReadTimeoutError = (error: unknown) => {
  if (
    publicReadTimeout.getStore() === undefined ||
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
