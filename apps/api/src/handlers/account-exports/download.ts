import { Result } from "better-result";

import { accountExportParams } from "@/api/handlers/account-exports/params";
import { recordAccountExportDownload } from "@/api/lib/account-export/store";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { openS3ObjectStreamWithSignal } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

const downloadPersonalDataExport = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    contract: "patch",
    mcp: { type: "internal", reason: "auth_plumbing" },
    params: accountExportParams,
    contentDelivery: { type: "audited" },
    transport: {
      type: "file-response",
      response: { mediaTypes: ["application/zip"] },
      alternative: {
        type: "partial",
        via: ["account-exports.download.get"],
        limitation:
          "Returns an authenticated download URL; ZIP bytes require HTTP.",
      },
    },
  },
  async function* ({ user, params: { exportId }, request }) {
    const row = yield* Result.await(
      Result.tryPromise(
        async () =>
          await recordAccountExportDownload({ id: exportId, userId: user.id }),
      ),
    );
    const objectKey = row?.objectKey ?? null;
    if (row === null || objectKey === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Export is unavailable or expired.",
        }),
      );
    }
    const source = yield* Result.await(
      Result.tryPromise(
        async () =>
          await openS3ObjectStreamWithSignal(objectKey, request.signal),
      ),
    );
    return Result.ok(
      secureDocumentResponse({
        body: source.body,
        contentType: "application/zip",
        disposition: "attachment",
        fileName: sanitizeFilename(`personal-data-${row.id}.zip`),
        ...(source.contentLength === undefined
          ? {}
          : { contentLength: source.contentLength }),
        additionalHeaders: { [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL },
      }),
    );
  },
);

export default downloadPersonalDataExport;
