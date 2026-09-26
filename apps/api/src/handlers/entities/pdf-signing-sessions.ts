import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entityVersions, pdfSigningSessions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { PdfSigningSessionView } from "@/api/lib/files/pdf-signing/sessions";
import { resolvePdfSigningSessionStatus } from "@/api/lib/files/pdf-signing/sessions";

const paramsSchema = workspaceParams({
  sessionId: tSafeId("pdfSigningSession"),
});

type ReadSessionOptions = {
  safeDb: SafeDb;
  sessionId: SafeId<"pdfSigningSession">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * The exchange as its initiator sees it. Scoped to `created_by` as well as
 * the workspace: a signing exchange is one person's, and nobody else needs
 * to watch it.
 */
const readSessionRow = async ({
  safeDb,
  sessionId,
  userId,
  workspaceId,
}: ReadSessionOptions) =>
  await safeDb(
    async (tx) =>
      await tx
        .select({
          closeReason: pdfSigningSessions.closeReason,
          finalizedVersionId: pdfSigningSessions.finalizedVersionId,
          finalizedVersionNumber: entityVersions.versionNumber,
          status: pdfSigningSessions.status,
          tokenExpiresAt: pdfSigningSessions.tokenExpiresAt,
        })
        .from(pdfSigningSessions)
        .leftJoin(
          entityVersions,
          eq(entityVersions.id, pdfSigningSessions.finalizedVersionId),
        )
        .where(
          and(
            eq(pdfSigningSessions.id, sessionId),
            eq(pdfSigningSessions.workspaceId, workspaceId),
            eq(pdfSigningSessions.createdBy, userId),
          ),
        )
        .limit(1),
  );

const sessionNotFound = () =>
  new HandlerError({
    status: 404,
    code: "pdf_signing_session_not_found",
    message: "Signing session not found.",
  });

const statusConfig = {
  params: paramsSchema,
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

export const readPdfSigningSessionStatus = createSafeHandler<
  typeof statusConfig,
  PdfSigningSessionView
>(
  statusConfig,
  async function* ({ params: { sessionId }, safeDb, user, workspaceId }) {
    const rows = yield* Result.await(
      readSessionRow({ safeDb, sessionId, userId: user.id, workspaceId }),
    );

    const session = rows.at(0);
    if (!session) {
      return Result.err(sessionNotFound());
    }

    return Result.ok(
      resolvePdfSigningSessionStatus({ ...session, now: new Date() }),
    );
  },
);

const cancelConfig = {
  params: paramsSchema,
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

export const cancelPdfSigningSession = createSafeHandler<
  typeof cancelConfig,
  PdfSigningSessionView
>(
  cancelConfig,
  async function* ({
    params: { sessionId },
    recordAuditEvent,
    safeDb,
    user,
    workspaceId,
  }) {
    // The conditional UPDATE is the whole decision: an already closed or
    // finalized exchange updates no row, so cancelling twice cannot undo a
    // signature that landed in between.
    yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .update(pdfSigningSessions)
          .set({
            closeReason: "user_cancelled",
            closedAt: new Date(),
            status: "cancelled",
          })
          .where(
            and(
              eq(pdfSigningSessions.id, sessionId),
              eq(pdfSigningSessions.workspaceId, workspaceId),
              eq(pdfSigningSessions.createdBy, user.id),
              eq(pdfSigningSessions.status, "open"),
            ),
          )
          .returning({ id: pdfSigningSessions.id });

        if (rows.at(0)) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
            resourceId: sessionId,
            changes: { status: { old: "open", new: "cancelled" } },
            metadata: { closeReason: "user_cancelled" },
          });
        }
      }),
    );

    const rows = yield* Result.await(
      readSessionRow({ safeDb, sessionId, userId: user.id, workspaceId }),
    );

    const session = rows.at(0);
    if (!session) {
      return Result.err(sessionNotFound());
    }

    return Result.ok(
      resolvePdfSigningSessionStatus({ ...session, now: new Date() }),
    );
  },
);
