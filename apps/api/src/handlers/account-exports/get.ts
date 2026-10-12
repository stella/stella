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
    mcp: {
      type: "capability",
      reason: "reporting_export",
      consumesServices: false,
      readClass: "tenant",
    },
    description:
      "Read your most recent personal data export as latest, which is null before your first request. Use account-exports.create to request an export, account-exports.status.get to poll its ID, and account-exports.download.get when it is ready.",
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
