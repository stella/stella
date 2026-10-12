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
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const ACCOUNT_EXPORT_ENQUEUE_FAILED = failureSink({
  event: "account_export.enqueue_failed",
  expected: [],
});

const requestPersonalDataExport = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    contract: "patch",
    access: "write",
    realtime: noResourceSetUpdates(
      "Account-scoped export state refreshes through the caller-owned query",
    ),
    mcp: {
      type: "capability",
      reason: "reporting_export",
      consumesServices: false,
    },
    description:
      "Request an asynchronous export of your own personal data across current organization memberships. Organization and matter content are excluded. One active export is reused. Poll account-exports.status.get with the returned id as exportId, then call account-exports.download.get when ready. Pass nextCall to read_capability. Downloads require your authenticated account and expire after one hour.",
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
        ctx: { jobId: row.id },
        request,
      });
    }
    return Result.ok({
      ...accountExportStatus(row),
      nextCall: {
        capability: "account-exports.status.get",
        input: { params: { exportId: row.id } },
      },
    });
  },
);

declareAggregateMutation(requestPersonalDataExport.handler, {
  type: "independent",
  reason:
    "The export store serializes the request under the account and export aggregate locks in one audited transaction.",
});

export default requestPersonalDataExport;
