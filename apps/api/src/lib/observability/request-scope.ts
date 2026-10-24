// The single async scope every HTTP request runs inside.
//
// Both per-request ambient stores (the receipt id and the dev/CI DB query
// counter) are opened here, together, so a request cannot end up carrying one
// and not the other. The HTTP layer applies it once, around the whole composed
// handler (see `scopeRequestAsyncStores` in `server.ts`); nothing else should
// open either store for a request.

import {
  runWithMeasuredQueryCounter,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import repeatedSqlFingerprintLedger from "@/api/lib/observability/repeated-sql-fingerprints.json";
import { runWithRequestIdScope } from "@/api/lib/observability/request-context";
import { isLocalDevOpen, isLocalTestRun } from "@/api/runtime-mode";

export const runWithRequestScope = <TResult>(fn: () => TResult): TResult =>
  runWithRequestIdScope(() =>
    runWithQueryCounter(() => fn(), {
      countTransactions: isLocalDevOpen(),
    }),
  );

/** Integration requests enforce fingerprints even without a Postgres fixture. */
export const runWithHttpRequestScope = async <TResult>(
  fn: () => Promise<TResult>,
): Promise<TResult> =>
  isLocalTestRun()
    ? await runWithRequestIdScope(
        async () =>
          await runWithMeasuredQueryCounter(fn, repeatedSqlFingerprintLedger),
      )
    : await runWithRequestScope(fn);
