import { Result } from "better-result";

import { enqueueAccountExport } from "@/api/lib/account-export/queue";
import {
  accountExportStatus,
  requestAccountExport,
} from "@/api/lib/account-export/store";
import { captureError } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";

const requestPersonalDataExport = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    access: "write",
    mcp: { type: "capability", consumesServices: false },
    description:
      "Request an asynchronous export of your own personal data across current organization memberships. Organization and matter content are excluded. One active export is reused. Poll account-exports.status.get with the returned id as exportId, then call account-exports.download.get when ready. Pass nextCall to read_capability. Downloads require your authenticated account and expire after one hour.",
  },
  async function* ({ user }) {
    const row = yield* Result.await(requestAccountExport(user.id));
    // Queue transport is reconstructible from the committed ledger. A failed
    // enqueue must not turn an accepted request into an ambiguous refusal.
    const queued = await Result.tryPromise(
      async () => await enqueueAccountExport(row.id),
    );
    if (Result.isError(queued)) {
      captureError(queued.error, { exportId: row.id });
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

export default requestPersonalDataExport;
