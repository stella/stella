import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, SafeDbError, Transaction } from "@/api/db";
import {
  desktopEditSessions,
  entityVersions,
  folioCollabSessions,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  expiredOwnDesktopEditSessionTargetPredicates,
  liveDesktopEditSessionPredicates,
  liveOwnDesktopEditSessionTargetPredicates,
} from "@/api/lib/desktop-edit-session-predicates";
import {
  computeTokenExpiresAt,
  createDesktopEditSessionToken,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { broadcast } from "@/api/lib/sse";

import {
  lockDocxEditTarget,
  presignDocxDownloadFromFileId,
  presignDocxFieldDownload,
  readCurrentDocxTarget,
  readVersionDocxTarget,
} from "./desktop-edit-session-utils";

export const openDesktopEditSessionBodySchema = t.Object({
  entityId: tSafeId("entity"),
  force: t.Optional(t.Boolean()),
  propertyId: tSafeId("property"),
});

export type OpenDesktopEditSessionResponse = {
  baseVersionNumber: number;
  downloadUrl: string;
  fileName: string;
  lastCheckpointAt: string | null;
  resumedFromCheckpoint: boolean;
  sessionId: SafeId<"desktopEditSession">;
  sessionToken: string;
  tookOverExistingSession: boolean;
};

type OpenDesktopEditSessionHandlerProps = {
  body: Static<typeof openDesktopEditSessionBodySchema>;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const isUniqueViolationSafeDbError = (error: SafeDbError): boolean =>
  "cause" in error && isPgError(error.cause, PG_ERROR.UNIQUE_VIOLATION);

type ExistingOpenDesktopEditSession = {
  baseVersionId: SafeId<"entityVersion">;
  checkpointFileId: SafeId<"userFile">;
  checkpointUpdatedAt: Date | null;
  fileName: string;
  id: SafeId<"desktopEditSession">;
};

const readExistingOpenDesktopEditSession = async ({
  entityId,
  now,
  propertyId,
  tx,
  userId,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  now: Date;
  propertyId: SafeId<"property">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}) => {
  const existingSessions = await tx
    .select({
      baseVersionId: desktopEditSessions.baseVersionId,
      checkpointFileId: desktopEditSessions.checkpointFileId,
      checkpointUpdatedAt: desktopEditSessions.checkpointUpdatedAt,
      fileName: desktopEditSessions.fileName,
      id: desktopEditSessions.id,
    })
    .from(desktopEditSessions)
    .where(
      and(
        ...liveOwnDesktopEditSessionTargetPredicates({
          entityId,
          now,
          propertyId,
          userId,
          workspaceId,
        }),
      ),
    )
    .limit(1)
    .for("update");

  return existingSessions.at(0) ?? null;
};

const expireStaleOwnDesktopEditSessions = async ({
  entityId,
  now,
  propertyId,
  recordAuditEvent,
  tx,
  userId,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  now: Date;
  propertyId: SafeId<"property">;
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}) => {
  const expiredSessions = await tx
    .update(desktopEditSessions)
    .set({ status: "expired", closedAt: now })
    .where(
      and(
        ...expiredOwnDesktopEditSessionTargetPredicates({
          entityId,
          now,
          propertyId,
          userId,
          workspaceId,
        }),
      ),
    )
    .returning({ id: desktopEditSessions.id });

  if (expiredSessions.length === 0) {
    return;
  }

  await recordAuditEvent(
    tx,
    expiredSessions.map((session) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
      resourceId: session.id,
      changes: { status: { old: "open", new: "expired" } },
      metadata: { reason: "token_expired_on_open" },
    })),
  );
};

const buildExistingOpenDesktopEditSessionResponse = async ({
  existingSession,
  organizationId,
  propertyId,
  recordAuditEvent,
  sessionToken,
  sessionTokenHash,
  tx,
  workspaceId,
}: {
  existingSession: ExistingOpenDesktopEditSession;
  organizationId: SafeId<"organization">;
  propertyId: SafeId<"property">;
  recordAuditEvent: AuditRecorder;
  sessionToken: string;
  sessionTokenHash: string;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
}) => {
  const baseVersionRows = await tx
    .select({
      versionNumber: entityVersions.versionNumber,
    })
    .from(entityVersions)
    .where(eq(entityVersions.id, existingSession.baseVersionId))
    .limit(1);
  const baseVersion = baseVersionRows.at(0);

  if (!baseVersion) {
    return {
      error: {
        message: "Desktop edit session is missing its base version.",
        statusCode: 409,
      },
    } as const;
  }

  const updatedSessions = await tx
    .update(desktopEditSessions)
    .set({
      sessionTokenHash,
      tokenExpiresAt: computeTokenExpiresAt(),
    })
    .where(
      and(
        eq(desktopEditSessions.id, existingSession.id),
        ...liveDesktopEditSessionPredicates(new Date()),
      ),
    )
    .returning({ id: desktopEditSessions.id });

  if (!updatedSessions.at(0)) {
    return null;
  }

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
    resourceId: existingSession.id,
    changes: {
      sessionTokenHash: { old: "***", new: "***" },
    },
    metadata: { reason: "resumed_existing_session" },
  });

  if (existingSession.checkpointUpdatedAt) {
    return {
      baseVersionNumber: baseVersion.versionNumber,
      downloadUrl: presignDocxDownloadFromFileId({
        fileId: existingSession.checkpointFileId,
        fileName: existingSession.fileName,
        organizationId,
        workspaceId,
      }),
      fileName: existingSession.fileName,
      lastCheckpointAt: existingSession.checkpointUpdatedAt.toISOString(),
      resumedFromCheckpoint: true,
      sessionId: existingSession.id,
      sessionToken,
      tookOverExistingSession: true,
    } satisfies OpenDesktopEditSessionResponse;
  }

  const baseVersionContent = await readVersionDocxTarget({
    entityVersionId: existingSession.baseVersionId,
    propertyId,
    tx,
    workspaceId,
  });

  if (!baseVersionContent) {
    return {
      error: {
        message: "Desktop edit session source file is no longer available.",
        statusCode: 409,
      },
    } as const;
  }

  return {
    baseVersionNumber: baseVersion.versionNumber,
    downloadUrl: presignDocxFieldDownload({
      fileContent: baseVersionContent,
      organizationId,
      workspaceId,
    }),
    fileName: baseVersionContent.fileName,
    lastCheckpointAt: null,
    resumedFromCheckpoint: false,
    sessionId: existingSession.id,
    sessionToken,
    tookOverExistingSession: true,
  } satisfies OpenDesktopEditSessionResponse;
};

export const openDesktopEditSessionHandler = async function* ({
  body: { entityId, force, propertyId },
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
  workspaceId,
}: OpenDesktopEditSessionHandlerProps) {
  const sessionToken = createDesktopEditSessionToken();
  const sessionTokenHash = hashDesktopEditSessionToken(sessionToken);

  // Force-takeover: reassign one open session to the current user by
  // updating createdBy + session token. The previous user's next
  // checkpoint/finalize will get a 409 "taken over" response; their
  // local copy is preserved. The new user resumes from the latest
  // checkpoint. Uses SELECT + UPDATE-by-ID to avoid updating multiple
  // sessions if duplicates exist.
  if (force) {
    yield* Result.await(
      safeDb(async (tx) => {
        await lockDocxEditTarget({
          entityId,
          propertyId,
          tx,
          workspaceId,
        });

        const existing = await tx
          .select({
            id: desktopEditSessions.id,
            createdBy: desktopEditSessions.createdBy,
          })
          .from(desktopEditSessions)
          .where(
            and(
              eq(desktopEditSessions.entityId, entityId),
              eq(desktopEditSessions.propertyId, propertyId),
              eq(desktopEditSessions.workspaceId, workspaceId),
              ...liveDesktopEditSessionPredicates(new Date()),
            ),
          )
          .orderBy(desktopEditSessions.createdAt)
          .limit(1);

        const target = existing.at(0);
        if (target) {
          await tx
            .update(desktopEditSessions)
            .set({
              createdBy: userId,
              sessionTokenHash,
              tokenExpiresAt: computeTokenExpiresAt(),
              takeoverRequestedBy: null,
              takeoverRequestedAt: null,
            })
            .where(eq(desktopEditSessions.id, target.id));

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
            resourceId: target.id,
            changes: {
              createdBy: { old: target.createdBy, new: userId },
            },
            metadata: { reason: "force_takeover" },
          });
        }
      }),
    );
  }

  const runOpenSession = async ({ allowInsert }: { allowInsert: boolean }) =>
    await safeDb(async (tx) => {
      await lockDocxEditTarget({
        entityId,
        propertyId,
        tx,
        workspaceId,
      });

      const now = new Date();
      await expireStaleOwnDesktopEditSessions({
        entityId,
        now,
        propertyId,
        recordAuditEvent,
        tx,
        userId,
        workspaceId,
      });

      const existingSession = await readExistingOpenDesktopEditSession({
        entityId,
        now: new Date(),
        propertyId,
        tx,
        userId,
        workspaceId,
      });

      if (existingSession) {
        return await buildExistingOpenDesktopEditSessionResponse({
          existingSession,
          organizationId,
          propertyId,
          recordAuditEvent,
          sessionToken,
          sessionTokenHash,
          tx,
          workspaceId,
        });
      }

      if (!allowInsert) {
        return null;
      }

      const currentTarget = await readCurrentDocxTarget({
        entityId,
        propertyId,
        tx,
        workspaceId,
      });

      if (!currentTarget) {
        return {
          error: {
            message: "Target property is not an editable DOCX field.",
            statusCode: 400 as const,
          },
        } as const;
      }

      const collabSessions = await tx
        .select({ id: folioCollabSessions.id })
        .from(folioCollabSessions)
        .where(
          and(
            eq(folioCollabSessions.entityId, entityId),
            eq(folioCollabSessions.propertyId, propertyId),
            eq(folioCollabSessions.workspaceId, workspaceId),
            eq(folioCollabSessions.status, "open"),
          ),
        )
        .limit(1);

      if (collabSessions.at(0)) {
        return {
          error: {
            message:
              "This document already has a collaborative edit session open.",
            statusCode: 409 as const,
          },
        } as const;
      }

      const sessionId = createSafeId<"desktopEditSession">();
      const checkpointFileId = createSafeId<"userFile">();

      await tx.insert(desktopEditSessions).values({
        baseVersionId: currentTarget.baseVersionId,
        checkpointFileId,
        createdBy: userId,
        entityId,
        fileName: currentTarget.fileContent.fileName,
        id: sessionId,
        propertyId,
        sessionTokenHash,
        tokenExpiresAt: computeTokenExpiresAt(),
        workspaceId,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
        resourceId: sessionId,
        changes: {
          created: {
            old: null,
            new: {
              entityId,
              propertyId,
              baseVersionId: currentTarget.baseVersionId,
              fileName: currentTarget.fileContent.fileName,
            },
          },
        },
      });

      return {
        baseVersionNumber: currentTarget.baseVersionNumber,
        downloadUrl: presignDocxFieldDownload({
          fileContent: currentTarget.fileContent,
          organizationId,
          workspaceId,
        }),
        fileName: currentTarget.fileContent.fileName,
        lastCheckpointAt: null,
        resumedFromCheckpoint: false,
        sessionId,
        sessionToken,
        tookOverExistingSession: false,
      } satisfies OpenDesktopEditSessionResponse;
    });

  let firstAttempt = await runOpenSession({ allowInsert: true });

  // Handle unique violation: retry without insert, then with insert
  if (Result.isError(firstAttempt)) {
    const error = firstAttempt.error;
    if (isUniqueViolationSafeDbError(error)) {
      const retryResult = await runOpenSession({ allowInsert: false });
      if (Result.isError(retryResult)) {
        return Result.err(retryResult.error);
      }
      if (retryResult.value !== null) {
        firstAttempt = retryResult;
      } else {
        firstAttempt = Result.ok(null);
      }
    } else {
      return Result.err(error);
    }
  }

  let result = firstAttempt.value;

  if (result === null) {
    const retryResult = yield* Result.await(
      runOpenSession({ allowInsert: true }),
    );

    if (retryResult === null) {
      return Result.err(
        new HandlerError({
          status: 500,
          message:
            "Desktop edit session changed while opening. Please try again.",
        }),
      );
    }

    result = retryResult;
  }

  if ("error" in result) {
    return Result.err(
      new HandlerError({
        status: result.error.statusCode,
        message: result.error.message,
      }),
    );
  }

  return Result.ok(result);
};

const config = {
  body: openDesktopEditSessionBodySchema,
  permissions: { entity: ["update"] },
} satisfies HandlerConfig;

const openDesktopEditSession = createSafeHandler(
  config,
  async function* ({
    body,
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const result = yield* openDesktopEditSessionHandler({
      body,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
      workspaceId,
    });

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return result;
  },
);

export default openDesktopEditSession;
