import { Result, TaggedError } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { resolveUiLocale } from "@stll/locales";

import type { ScopedDb } from "@/api/db/safe-db";
import { reportExports } from "@/api/db/schema";
import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isTransactionalEmailConfigured,
  sendReportExportStatusEmail,
} from "@/api/lib/email/email";

export type ReportExportNotificationEmail = Parameters<
  typeof sendReportExportStatusEmail
>[0];

type ReportExportNotificationDelivery = {
  isConfigured: () => boolean;
  send: (email: ReportExportNotificationEmail) => Promise<void>;
};

type NotifyReportExportStatusOptions = {
  delivery?: ReportExportNotificationDelivery;
  exportId: SafeId<"reportExport">;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type ReportExportNotificationResult =
  | { status: "sent" }
  | { status: "suppressed" }
  | { status: "delivery_failed" }
  | { status: "claim_failed" }
  | { status: "finalize_failed" }
  | { status: "skipped" };

const defaultDelivery: ReportExportNotificationDelivery = {
  isConfigured: isTransactionalEmailConfigured,
  send: sendReportExportStatusEmail,
};

/**
 * Claims and sends one terminal export notification at most once.
 *
 * The claim transitions `pending` to `sending` before the external email call.
 * A crash can therefore omit a notification, but neither a BullMQ redelivery
 * nor two workers racing the same row can send it twice. Finalization failure
 * leaves the claim in `sending` and returns `finalize_failed`, preserving that
 * at-most-once boundary without reporting a terminal outcome. The message
 * contract contains only terminal status, locale, recipient, and a tenant-scoped
 * export recovery URL; report content and artifact metadata never enter this
 * boundary.
 */
export const notifyReportExportStatus = async ({
  delivery = defaultDelivery,
  exportId,
  scopedDb,
  userId,
  workspaceId,
}: NotifyReportExportStatusOptions): Promise<ReportExportNotificationResult> => {
  const claimResult = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        // audit: skip — atomic delivery-bookkeeping claim on an
        // already-audited export row.
        const claimedRows = await tx
          .update(reportExports)
          .set({
            notificationAttemptedAt: new Date(),
            notificationStatus: "sending",
          })
          .where(
            and(
              eq(reportExports.id, exportId),
              eq(reportExports.workspaceId, workspaceId),
              eq(reportExports.requestedBy, userId),
              eq(reportExports.notificationStatus, "pending"),
              inArray(reportExports.status, ["completed", "failed"]),
            ),
          )
          .returning({
            lang: reportExports.notificationLang,
            status: reportExports.status,
          });
        return claimedRows;
      }),
  );
  if (Result.isError(claimResult)) {
    captureNotificationError(claimResult.error, {
      exportId,
      operation: "claim",
      workspaceId,
    });
    return { status: "claim_failed" };
  }

  const claim = claimResult.value.at(0);
  if (claim === undefined) {
    return { status: "skipped" };
  }

  const configuredResult = Result.try(() => delivery.isConfigured());
  if (Result.isError(configuredResult)) {
    captureNotificationError(configuredResult.error, {
      exportId,
      operation: "configuration",
      workspaceId,
    });
    return finalizeNotificationStatus({
      exportId,
      scopedDb,
      status: "delivery_failed",
      workspaceId,
    });
  }
  if (!configuredResult.value) {
    return finalizeNotificationStatus({
      exportId,
      scopedDb,
      status: "suppressed",
      workspaceId,
    });
  }

  const recipientResult = await Result.tryPromise(
    async () =>
      await scopedDb((tx) =>
        tx.query.user.findFirst({
          where: { id: { eq: userId } },
          columns: { email: true, emailVerified: true },
        }),
      ),
  );
  if (Result.isError(recipientResult)) {
    captureNotificationError(recipientResult.error, {
      exportId,
      operation: "recipient",
      workspaceId,
    });
    return finalizeNotificationStatus({
      exportId,
      scopedDb,
      status: "delivery_failed",
      workspaceId,
    });
  }

  const recipient = recipientResult.value;
  if (recipient === undefined || !recipient.emailVerified) {
    return finalizeNotificationStatus({
      exportId,
      scopedDb,
      status: "suppressed",
      workspaceId,
    });
  }

  const status = claim.status === "completed" ? "completed" : "failed";
  const deliveryResult = await Result.tryPromise(
    async () =>
      await delivery.send({
        appUrl: reportExportRecoveryUrl({ exportId, workspaceId }),
        email: recipient.email,
        lang: resolveUiLocale(claim.lang) ?? "en",
        status,
      }),
  );
  if (Result.isError(deliveryResult)) {
    captureNotificationError(deliveryResult.error, {
      exportId,
      operation: "send",
      workspaceId,
    });
    return finalizeNotificationStatus({
      exportId,
      scopedDb,
      status: "delivery_failed",
      workspaceId,
    });
  }

  return finalizeNotificationStatus({
    exportId,
    scopedDb,
    status: "sent",
    workspaceId,
  });
};

type ReportExportRecoveryUrlOptions = {
  exportId: SafeId<"reportExport">;
  workspaceId: SafeId<"workspace">;
};

const reportExportRecoveryUrl = ({
  exportId,
  workspaceId,
}: ReportExportRecoveryUrlOptions): string =>
  new URL(
    `/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(exportId)}`,
    env.FRONTEND_URL,
  ).toString();

type FinalNotificationStatus = "delivery_failed" | "sent" | "suppressed";

type FinalizeNotificationStatusOptions = {
  exportId: SafeId<"reportExport">;
  scopedDb: ScopedDb;
  status: FinalNotificationStatus;
  workspaceId: SafeId<"workspace">;
};

type NotificationFinalizationResult = {
  status: FinalNotificationStatus | "finalize_failed";
};

class NotificationFinalizationError extends TaggedError(
  "NotificationFinalizationError",
)<{ affectedRows: number; message: string }>() {}

const finalizeNotificationStatus = async ({
  exportId,
  scopedDb,
  status,
  workspaceId,
}: FinalizeNotificationStatusOptions): Promise<NotificationFinalizationResult> => {
  const result = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        // audit: skip — delivery bookkeeping on an already-audited export row.
        const updatedRows = await tx
          .update(reportExports)
          .set({ notificationStatus: status })
          .where(
            and(
              eq(reportExports.id, exportId),
              eq(reportExports.workspaceId, workspaceId),
              eq(reportExports.notificationStatus, "sending"),
            ),
          )
          .returning({ id: reportExports.id });
        return updatedRows;
      }),
  );
  if (Result.isError(result)) {
    captureNotificationError(result.error, {
      exportId,
      operation: "finalize",
      workspaceId,
    });
    return { status: "finalize_failed" };
  }

  if (result.value.length !== 1) {
    captureNotificationError(
      new NotificationFinalizationError({
        affectedRows: result.value.length,
        message:
          "Report export notification finalization must affect exactly one row",
      }),
      {
        exportId,
        operation: "finalize",
        workspaceId,
      },
    );
    return { status: "finalize_failed" };
  }

  return { status };
};

type NotificationErrorContext = {
  exportId: SafeId<"reportExport">;
  operation: "claim" | "configuration" | "finalize" | "recipient" | "send";
  workspaceId: SafeId<"workspace">;
};

const captureNotificationError = (
  error: unknown,
  { exportId, operation, workspaceId }: NotificationErrorContext,
) => {
  captureError(error, {
    exportId,
    operation: `report_export.notification.${operation}`,
    workspaceId,
  });
};
