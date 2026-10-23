import { Result } from "better-result";
import { t } from "elysia";

import { accountExportStatusSchema } from "@/api/handlers/account-exports/response";
import {
  accountExportStatus,
  readLatestAccountExport,
} from "@/api/lib/account-export/store";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";

const latestPersonalDataExport = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    contract: "patch",
    response: safeHandlerResponseSchemas(
      t.Object({ latest: t.Union([accountExportStatusSchema, t.Null()]) }),
    ),
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
