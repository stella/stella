import { Result } from "better-result";
import { t } from "elysia";

import { enqueueAccountExport } from "@/api/lib/account-export/queue";
import {
  accountExportStatus,
  readAccountExport,
  readLatestAccountExport,
  recordAccountExportDownload,
  requestAccountExport,
} from "@/api/lib/account-export/store";
import { captureError } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { openS3ObjectStreamWithSignal } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

const accountExportParams = t.Object({
  exportId: t.String({ format: "uuid" }),
});
const accountConfig = {
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "auth_plumbing" },
} as const satisfies SessionHandlerConfig;

export const requestPersonalDataExport = createSafeSessionHandler(
  accountConfig,
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
    return Result.ok(accountExportStatus(row));
  },
);

export const latestPersonalDataExport = createSafeSessionHandler(
  accountConfig,
  async function* ({ user }) {
    const row = yield* Result.await(readLatestAccountExport(user.id));
    return Result.ok(row === null ? null : accountExportStatus(row));
  },
);

export const personalDataExportStatus = createSafeSessionHandler(
  { ...accountConfig, params: accountExportParams },
  async function* ({ user, params: { exportId } }) {
    const row = yield* Result.await(
      readAccountExport({ id: exportId, userId: user.id }),
    );
    if (row === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Export not found." }),
      );
    }
    return Result.ok(accountExportStatus(row));
  },
);

export const downloadPersonalDataExport = createSafeSessionHandler(
  {
    ...accountConfig,
    params: accountExportParams,
    contentDelivery: { type: "audited" },
    transport: {
      type: "file-response",
      response: { mediaTypes: ["application/zip"] },
      alternative: {
        type: "none",
        reason:
          "Account settings downloads use the authenticated HTTP endpoint.",
      },
    },
  },
  async function* ({ user, params: { exportId }, request }) {
    const row = yield* Result.await(
      recordAccountExportDownload({ id: exportId, userId: user.id }),
    );
    if (row === null || row.objectKey === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Export is unavailable or expired.",
        }),
      );
    }
    const objectKey = row.objectKey;
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
        contentLength: source.contentLength,
        additionalHeaders: { [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL },
      }),
    );
  },
);
