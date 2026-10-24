import { Result } from "better-result";

import { buildVersionedApiUrl } from "@stll/api-contract";

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
import { getMcpBaseUrl } from "@/api/mcp/constants";

const personalDataExportDownloadLink = createSafeSessionHandler(
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
    params: accountExportParams,
    description:
      "Get an expiring authenticated download URL for your ready personal data export. Returns downloadUrl and expiresAt, never archive bytes. Open the URL in a browser signed in to the same account, or fetch it with an OAuth token that has stella:account_export_read consent. Poll account-exports.status.get while building; call account-exports.create for an expired or failed export.",
  },
  async function* ({ user, params: { exportId } }) {
    const row = yield* Result.await(
      Result.tryPromise(
        async () => await readAccountExport({ id: exportId, userId: user.id }),
      ),
    );
    const status = row === null ? null : accountExportStatus(row);
    if (status?.status !== "ready") {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "account_export_download_unavailable",
          message: "Export is unavailable or expired.",
          hint: "Poll account-exports.status.get while building; call account-exports.create if failed or expired.",
        }),
      );
    }
    return Result.ok({
      id: status.id,
      download: {
        downloadUrl: buildVersionedApiUrl(
          getMcpBaseUrl(),
          `/me/data-exports/${encodeURIComponent(status.id)}/download`,
        ),
        expiresAt: status.expiresAt.toISOString(),
      },
    });
  },
);

export default personalDataExportDownloadLink;
