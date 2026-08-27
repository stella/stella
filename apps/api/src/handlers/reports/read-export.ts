/**
 * Report export status.
 *
 * Returns the export's lifecycle state and, for a completed download-mode
 * export, a short-lived presigned URL scoped to the requesting workspace. A
 * save-to-workspace export instead returns the created document entity id. The
 * row is read under RLS (workspace-scoped) AND scoped to the requesting user:
 * only the requester's client polls this endpoint, so least privilege costs
 * nothing and a same-workspace member can never fish another export's
 * download URL by id.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { reportExports } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { presignDownloadUrl } from "@/api/lib/s3-presign";

import { resolvedReportResultFieldId } from "./result-field";

/** Presigned result URLs are short-lived; the client fetches immediately. */
const DOWNLOAD_URL_EXPIRES_SECONDS = 5 * 60;

/** Name the download after the stored key's extension (.docx or .pdf), so the
 *  chosen output format travels via the S3 key with no extra column. */
const downloadFileName = (resultS3Key: string): string =>
  resultS3Key.endsWith(".pdf") ? "report.pdf" : "report.docx";

// permissions-exempt: workspace:read is sufficient even though access is
// "write". The one write here (nulling a stale resultS3Key) is bookkeeping
// on a row the caller already owns (requestedBy = user.id, scoped below),
// not a new grant of capability; creating the export required entity:create
// at export-view.ts, so a caller with nothing to poll could never have
// reached one.
const config = {
  description:
    "Read a report export's status. Completed downloads include a short-lived URL; workspace exports include the created document ID.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "reporting_export" },
  access: "write",
  params: workspaceParams({ exportId: tSafeId("reportExport") }),
} satisfies HandlerConfig;

const readReportExport = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, user, params }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            status: reportExports.status,
            error: reportExports.error,
            mode: reportExports.mode,
            resultEntityId: reportExports.resultEntityId,
            resultFieldId: resolvedReportResultFieldId.as(
              "resolved_result_field_id",
            ),
            resultS3Key: reportExports.resultS3Key,
          })
          .from(reportExports)
          .where(
            and(
              eq(reportExports.id, params.exportId),
              eq(reportExports.workspaceId, workspaceId),
              eq(reportExports.requestedBy, user.id),
            ),
          )
          .limit(1),
      ),
    );
    const row = rows.at(0);

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
      const resultS3Key = row.resultS3Key;
      const objectExists = yield* Result.await(
        Result.tryPromise({
          try: async () => await getS3().exists(resultS3Key),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Failed to verify the report export.",
              cause,
            }),
        }),
      );
      if (!objectExists) {
        yield* Result.await(
          safeDb(async (tx) => {
            // audit: skip — lifecycle bookkeeping for an already-audited
            // export whose temporary S3 object no longer exists.
            await tx
              .update(reportExports)
              .set({ resultS3Key: null })
              .where(
                and(
                  eq(reportExports.id, params.exportId),
                  eq(reportExports.workspaceId, workspaceId),
                  eq(reportExports.requestedBy, user.id),
                  eq(reportExports.resultS3Key, resultS3Key),
                ),
              );
          }),
        );
      } else {
        downloadUrl = yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await presignDownloadUrl(resultS3Key, {
                expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS,
                fileName: downloadFileName(resultS3Key),
                scope: {
                  keyspace: "exports",
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
    }

    return Result.ok({
      status: row.status,
      error: row.error,
      resultEntityId: row.resultEntityId,
      resultFieldId: row.resultFieldId,
      downloadUrl,
    });
  },
);

export default readReportExport;
