import { Result } from "better-result";

import {
  accountExportStatus,
  readLatestAccountExport,
} from "@/api/lib/account-export/store";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";

const latestPersonalDataExport = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    contract: "patch",
    access: "read",
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* ({ user }) {
    const row = yield* Result.await(
      Result.tryPromise(async () => await readLatestAccountExport(user.id)),
    );
    return Result.ok({
      latest: row === null ? null : accountExportStatus(row),
    });
  },
);

export default latestPersonalDataExport;
