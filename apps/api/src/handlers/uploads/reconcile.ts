import { Result, panic } from "better-result";
import { t } from "elysia";

import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import {
  captureOutlookIngestion,
  outlookIngestionDiagnosticSchema,
} from "@/api/handlers/uploads/outlook-ingestion-diagnostics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const reconcileParamsSchema = t.Object({
  workspaceId: tSafeId("workspace"),
  uploadId: tSafeId("pendingUpload"),
});

const reconcileBodySchema = t.Optional(
  t.Object(
    { diagnostic: t.Optional(outlookIngestionDiagnosticSchema) },
    { additionalProperties: false },
  ),
);

const config = {
  description:
    "Read the durable state of a presigned upload after an uncertain client " +
    "outcome. The lookup is scoped to the authenticated user and workspace, " +
    "re-checks the upload purpose permission, performs no storage I/O, and is " +
    "safe to replay. Returns an explicit reserved, finalizing, retryable, " +
    "complete, or rejected state.",
  permissions: uploadRoutePermission,
  access: "read",
  mcp: { type: "capability", reason: "file_transport" },
  body: reconcileBodySchema,
  params: reconcileParamsSchema,
} satisfies HandlerConfig;

const reconcileUpload = createSafeHandler(
  config,
  async function* ({
    body,
    memberRole,
    params,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const upload = yield* Result.await(
      safeDb((tx) =>
        tx.query.pendingUploads.findFirst({
          where: {
            id: { eq: params.uploadId },
            userId: { eq: user.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            claimedAt: true,
            expiresAt: true,
            finalizedResult: true,
            purpose: true,
            rejectReason: true,
            status: true,
          },
        }),
      ),
    );
    if (!upload) {
      return Result.err(
        new HandlerError({ status: 404, message: "Upload not found" }),
      );
    }
    if (upload.purpose !== "email_ingest") {
      return Result.err(
        new HandlerError({ status: 404, message: "Upload not found" }),
      );
    }

    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: upload.purpose,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    const capture = (
      durableState: string,
      outcome:
        | "complete"
        | "in_progress"
        | "retryable_failure"
        | "terminal_failure",
      retryStage: "finalize" | "none" | "reconcile",
    ) =>
      captureOutlookIngestion({
        diagnostic: body?.diagnostic,
        durableState,
        operation: "reconcile",
        organizationId: session.activeOrganizationId,
        outcome,
        retryStage,
        userId: user.id,
        workspaceId,
      });

    switch (upload.status) {
      case "pending":
        capture("pending", "in_progress", "reconcile");
        return Result.ok({
          expiresAt: upload.expiresAt,
          state: "reserved" as const,
        });
      case "scanning":
        capture("scanning", "in_progress", "finalize");
        return Result.ok({
          claimedAt: upload.claimedAt,
          state: "finalizing" as const,
        });
      case "failed":
        capture("failed", "retryable_failure", "finalize");
        return Result.ok({
          reason: upload.rejectReason ?? "Finalize failed and can be retried",
          state: "retryable" as const,
        });
      case "rejected":
        capture("rejected", "terminal_failure", "none");
        return Result.ok({
          reason: upload.rejectReason ?? "Upload was rejected",
          state: "rejected" as const,
        });
      case "finalized":
        if (!upload.finalizedResult) {
          return panic("Finalized pending upload has no finalized result");
        }
        capture("finalized", "complete", "none");
        return Result.ok({
          finalizedResult: upload.finalizedResult,
          state: "complete" as const,
        });
      default:
        return panic("Unknown pending upload status");
    }
  },
);

export default reconcileUpload;
