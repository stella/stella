import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { pdfSigningSessions } from "@/api/db/schema";
import type { PdfSigningSessionCloseReason } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ClosePdfSigningSessionOptions = {
  /**
   * The finalize attempt closing it, if any. Fences the close: an attempt a
   * later one has superseded cannot end the exchange under it.
   */
  attempt?: number | undefined;
  closeReason: PdfSigningSessionCloseReason;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  sessionId: SafeId<"pdfSigningSession">;
};

/**
 * Cancel an exchange with the reason the browser will display.
 *
 * `status = 'open'` is part of the WHERE, so a cancel racing a finalize
 * cannot withdraw a signature that already landed; when no row changes the
 * audit event is skipped rather than recorded against a state that did not
 * transition.
 */
export const closePdfSigningSession = async ({
  attempt,
  closeReason,
  recordAuditEvent,
  safeDb,
  sessionId,
}: ClosePdfSigningSessionOptions): Promise<Result<void, HandlerError>> => {
  const closed = await safeDb(async (tx) => {
    const rows = await tx
      .update(pdfSigningSessions)
      .set({ closeReason, closedAt: new Date(), status: "cancelled" })
      .where(
        and(
          eq(pdfSigningSessions.id, sessionId),
          eq(pdfSigningSessions.status, "open"),
          attempt === undefined
            ? undefined
            : eq(pdfSigningSessions.finalizeAttempts, attempt),
        ),
      )
      .returning({ id: pdfSigningSessions.id });

    if (!rows.at(0)) {
      return;
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
      resourceId: sessionId,
      changes: { status: { old: "open", new: "cancelled" } },
      metadata: { closeReason },
    });
  });

  if (Result.isError(closed)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to close the signing session.",
        cause: closed.error,
      }),
    );
  }
  return Result.ok(undefined);
};
