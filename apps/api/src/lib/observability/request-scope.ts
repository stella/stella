// The single async scope every HTTP request runs inside.
//
// Both per-request ambient stores (the receipt id and the dev/CI DB query
// counter) are opened here, together, so a request cannot end up carrying one
// and not the other. The HTTP layer applies it once, around the whole composed
// handler (see `scopeRequestAsyncStores` in `server.ts`); nothing else should
// open either store for a request.

import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { runWithRequestIdScope } from "@/api/lib/observability/request-context";

export const runWithRequestScope = <TResult>(fn: () => TResult): TResult =>
  runWithRequestIdScope(() => runWithQueryCounter(() => fn()));
