/**
 * Report export status.
 *
 * Returns the export's lifecycle state and, for a completed download-mode
 * export, a short-lived presigned URL scoped to the requesting workspace. A
 * save-to-workspace export instead returns the created document entity id. The
 * row is read under RLS (workspace-scoped), so a caller can never poll another
 * workspace's export.
 */

import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { presignDownloadUrl } from "@/api/lib/s3-presign";

/** Presigned result URLs are short-lived; the client fetches immediately. */
const DOWNLOAD_URL_EXPIRES_SECONDS = 5 * 60;

/** Name the download after the stored key's extension (.docx or .pdf), so the
 *  chosen output format travels via the S3 key with no extra column. */
const downloadFileName = (resultS3Key: string): string =>
  resultS3Key.endsWith(".pdf") ? "report.pdf" : "report.docx";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  params: workspaceParams({ exportId: tSafeId("reportExport") }),
} satisfies HandlerConfig;

const readReportExport = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, params }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.reportExports.findFirst({
          where: {
            id: { eq: params.exportId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            status: true,
            error: true,
            mode: true,
            resultEntityId: true,
            resultS3Key: true,
          },
        }),
      ),
    );

    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Export not found" }),
      );
    }

    let downloadUrl: string | null = null;
    if (
      row.status === "completed" &&
      row.mode === "download" &&
      row.resultS3Key
    ) {
      downloadUrl = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await presignDownloadUrl(row.resultS3Key ?? "", {
              expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS,
              fileName: downloadFileName(row.resultS3Key ?? ""),
              scope: {
                organizationId: session.activeOrganizationId,
                workspaceId,
              },
            }),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Failed to sign the download URL.",
              cause,
            }),
        }),
      );
    }

    return Result.ok({
      status: row.status,
      error: row.error,
      resultEntityId: row.resultEntityId,
      downloadUrl,
    });
  },
);

export default readReportExport;
