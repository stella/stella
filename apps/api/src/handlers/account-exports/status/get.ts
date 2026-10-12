import { Result } from "better-result";

import { accountExportParams } from "@/api/handlers/account-exports/params";
import {
  accountExportStatus,
  readAccountExport,
} from "@/api/lib/account-export/store";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const personalDataExportStatus = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    contract: "patch",
    access: "read",
    mcp: {
      type: "capability",
      reason: "reporting_export",
      consumesServices: false,
      readClass: "tenant",
    },
    description:
      "Read the status of your personal data export by its returned ID. Requested or processing exports are still building; poll again later. For ready exports call account-exports.download.get. For failed or expired exports call account-exports.create to request a replacement.",
    params: accountExportParams,
  },
  async function* ({ user, params: { exportId } }) {
    const row = yield* Result.await(
      Result.tryPromise(
        async () => await readAccountExport({ id: exportId, userId: user.id }),
      ),
    );
    if (row === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Export not found.",
          hint: "Call account-exports.get for your latest export ID or account-exports.create to request one.",
        }),
      );
    }
    return Result.ok(accountExportStatus(row));
  },
);

export default personalDataExportStatus;
