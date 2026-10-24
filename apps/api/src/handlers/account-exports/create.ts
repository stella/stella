import { Result } from "better-result";

import { enqueueAccountExport } from "@/api/lib/account-export/enqueue";
import {
  accountExportStatus,
  requestAccountExport,
} from "@/api/lib/account-export/store";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { requireRequestExceptionScope } from "@/api/lib/observability/request-context";

const ACCOUNT_EXPORT_ENQUEUE_FAILED = failureSink({
  event: "account_export.enqueue_failed",
  expected: [],
});

const requestPersonalDataExport = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    contract: "patch",
    access: "write",
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* ({ user, request }) {
    const row = yield* Result.await(requestAccountExport(user.id));
    // Queue transport is reconstructible from the committed ledger. A failed
    // enqueue must not turn an accepted request into an ambiguous refusal.
    const queued = await Result.tryPromise(
      async () => await enqueueAccountExport(row.id),
    );
    if (Result.isError(queued)) {
      observeFailure(queued.error, {
        sink: ACCOUNT_EXPORT_ENQUEUE_FAILED,
        scope: requireRequestExceptionScope(request),
        ctx: { jobId: row.id },
        request,
      });
    }
    return Result.ok(accountExportStatus(row));
  },
);

declareAggregateMutation(requestPersonalDataExport.handler, {
  type: "independent",
  reason:
    "The export store serializes the request under the account and export aggregate locks in one audited transaction.",
});

export default requestPersonalDataExport;
