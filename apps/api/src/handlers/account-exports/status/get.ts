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
    mcp: { type: "internal", reason: "auth_plumbing" },
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
        new HandlerError({ status: 404, message: "Export not found." }),
      );
    }
    return Result.ok(accountExportStatus(row));
  },
);

export default personalDataExportStatus;
