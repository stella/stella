import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  entityVersions,
  folioCollabRooms,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import type { DesktopEditFileType } from "@/api/lib/desktop-edit-file-types";
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
import {
  lockDesktopEditTarget,
  presignDesktopEditDownloadFromFileId,
  presignDesktopEditFileDownload,
  readCurrentDesktopEditTarget,
  readVersionDesktopEditTarget,
} from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS } from "@/api/lib/folio-collab-room-contract";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";

export const openDesktopEditSessionBodySchema = t.Object({
  entityId: tSafeId("entity"),
  force: t.Optional(t.Boolean()),
  propertyId: tSafeId("property"),
});

type OpenDesktopEditSessionResponse = {
  baseVersionNumber: number;
  downloadUrl: string;
  fileName: string;
  fileType: DesktopEditFileType;
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
  fileType: DesktopEditFileType;
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
      fileType: desktopEditSessions.fileType,
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

const hasActiveFolioCollabRoom = async ({
  entityId,
  propertyId,
  tx,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
}) => {
  const rooms = await tx
    .select({ id: folioCollabRooms.id })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.entityId, entityId),
        eq(folioCollabRooms.propertyId, propertyId),
        eq(folioCollabRooms.workspaceId, workspaceId),
        sql`${folioCollabRooms.lastActivityAt} > now() - (${FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS} * interval '1 millisecond')`,
      ),
    )
    .limit(1)
    .for("update");

  return rooms.at(0) !== undefined;
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
      downloadUrl: await presignDesktopEditDownloadFromFileId({
        fileId: existingSession.checkpointFileId,
        fileName: existingSession.fileName,
        fileType: existingSession.fileType,
        organizationId,
        workspaceId,
      }),
      fileName: existingSession.fileName,
      fileType: existingSession.fileType,
      lastCheckpointAt: existingSession.checkpointUpdatedAt.toISOString(),
      resumedFromCheckpoint: true,
      sessionId: existingSession.id,
      sessionToken,
      tookOverExistingSession: true,
    } satisfies OpenDesktopEditSessionResponse;
  }

  const baseVersionTarget = await readVersionDesktopEditTarget({
    entityVersionId: existingSession.baseVersionId,
    fileType: existingSession.fileType,
    propertyId,
    tx,
    workspaceId,
  });

  if (!baseVersionTarget) {
    return {
      error: {
        message: "Desktop edit session source file is no longer available.",
        statusCode: 409,
      },
    } as const;
  }

  return {
    baseVersionNumber: baseVersion.versionNumber,
    downloadUrl: await presignDesktopEditFileDownload({
      fileTarget: baseVersionTarget,
      organizationId,
      workspaceId,
    }),
    fileName: baseVersionTarget.fileContent.fileName,
    fileType: existingSession.fileType,
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
        await lockDesktopEditTarget({
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

  const runOpenSession = async ({ allowInsert }: { allowInsert: boolean }) => {
    const result = await safeDb(async (tx) => {
      await lockDesktopEditTarget({
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
        return {
          value: await buildExistingOpenDesktopEditSessionResponse({
            existingSession,
            organizationId,
            propertyId,
            recordAuditEvent,
            sessionToken,
            sessionTokenHash,
            tx,
            workspaceId,
          }),
        };
      }

      if (!allowInsert) {
        return { value: null };
      }

      const currentTarget = await readCurrentDesktopEditTarget({
        entityId,
        propertyId,
        tx,
        workspaceId,
      });

      if (!currentTarget) {
        return {
          value: {
            error: {
              message:
                "Target property is not an editable DOCX, XLSX, or PPTX field.",
              statusCode: 400 as const,
            },
          },
        } as const;
      }

      if (
        await hasActiveFolioCollabRoom({
          entityId,
          propertyId,
          tx,
          workspaceId,
        })
      ) {
        return {
          value: {
            error: {
              message: "This document has active browser collaborators.",
              statusCode: 409 as const,
            },
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
        fileType: currentTarget.fileType,
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
              fileType: currentTarget.fileType,
            },
          },
        },
      });

      return {
        value: {
          baseVersionNumber: currentTarget.baseVersionNumber,
          downloadUrl: await presignDesktopEditFileDownload({
            fileTarget: currentTarget,
            organizationId,
            workspaceId,
          }),
          fileName: currentTarget.fileContent.fileName,
          fileType: currentTarget.fileType,
          lastCheckpointAt: null,
          resumedFromCheckpoint: false,
          sessionId,
          sessionToken,
          tookOverExistingSession: false,
        } satisfies OpenDesktopEditSessionResponse,
      };
    });

    if (Result.isError(result)) {
      return Result.err(result.error);
    }

    return Result.ok(result.value.value);
  };

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
  mcp: { type: "internal", reason: "session_token_exchange" },
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

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.ENTITY, id: body.entityId }),
    );

    return result;
  },
);

export default openDesktopEditSession;
