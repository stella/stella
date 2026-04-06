import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb, Transaction } from "@/api/db";
import { desktopEditSessions, entityVersions } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import {
  createDesktopEditSessionToken,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

import {
  presignDocxDownloadFromFileId,
  presignDocxFieldDownload,
  readCurrentDocxTarget,
  readVersionDocxTarget,
} from "./desktop-edit-session-utils";

const openDesktopEditSessionBodySchema = t.Object({
  entityId: tNanoid,
  propertyId: tNanoid,
});

type OpenDesktopEditSessionResponse = {
  baseVersionNumber: number;
  downloadUrl: string;
  fileName: string;
  lastCheckpointAt: string | null;
  resumedFromCheckpoint: boolean;
  sessionId: string;
  sessionToken: string;
  tookOverExistingSession: boolean;
};

type OpenDesktopEditSessionHandlerProps = {
  body: Static<typeof openDesktopEditSessionBodySchema>;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type ExistingOpenDesktopEditSession = {
  baseVersionId: string;
  checkpointFileId: string;
  checkpointUpdatedAt: Date | null;
  fileName: string;
  id: string;
};

const readExistingOpenDesktopEditSession = async ({
  entityId,
  propertyId,
  tx,
  userId,
  workspaceId,
}: {
  entityId: string;
  propertyId: string;
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
        eq(desktopEditSessions.createdBy, userId),
        eq(desktopEditSessions.entityId, entityId),
        eq(desktopEditSessions.propertyId, propertyId),
        eq(desktopEditSessions.status, "open"),
        eq(desktopEditSessions.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("update");

  return existingSessions.at(0) ?? null;
};

const buildExistingOpenDesktopEditSessionResponse = async ({
  existingSession,
  organizationId,
  propertyId,
  sessionToken,
  sessionTokenHash,
  tx,
  workspaceId,
}: {
  existingSession: ExistingOpenDesktopEditSession;
  organizationId: SafeId<"organization">;
  propertyId: string;
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
    })
    .where(
      and(
        eq(desktopEditSessions.id, existingSession.id),
        eq(desktopEditSessions.status, "open"),
      ),
    )
    .returning({ id: desktopEditSessions.id });

  if (!updatedSessions.at(0)) {
    return null;
  }

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

const openDesktopEditSessionHandler = async ({
  body: { entityId, propertyId },
  organizationId,
  scopedDb,
  userId,
  workspaceId,
}: OpenDesktopEditSessionHandlerProps) => {
  const sessionToken = createDesktopEditSessionToken();
  const sessionTokenHash = hashDesktopEditSessionToken(sessionToken);

  const runOpenSession = async ({
    allowInsert,
  }: {
    allowInsert: boolean;
  }) =>
    await scopedDb(async (tx) => {
      const existingSession = await readExistingOpenDesktopEditSession({
        entityId,
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
            statusCode: 400,
          },
        } as const;
      }

      const sessionId = crypto.randomUUID();
      const checkpointFileId = crypto.randomUUID();

      await tx.insert(desktopEditSessions).values({
        baseVersionId: currentTarget.baseVersionId,
        checkpointFileId,
        createdBy: userId,
        entityId,
        fileName: currentTarget.fileContent.fileName,
        id: sessionId,
        propertyId,
        sessionTokenHash,
        workspaceId,
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

  let result;

  try {
    result = await runOpenSession({ allowInsert: true });
  } catch (error) {
    if (!isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw error;
    }

    result = await runOpenSession({ allowInsert: false });
    if (result === null) {
      throw error;
    }
  }

  if (result === null) {
    result = await runOpenSession({ allowInsert: true });

    if (result === null) {
      throw new Error(
        "Desktop edit session changed while opening. Please try again.",
      );
    }
  }

  if ("error" in result) {
    return status(result.error.statusCode, {
      message: result.error.message,
    });
  }

  return result;
};

const config = {
  body: openDesktopEditSessionBodySchema,
  permissions: { entity: ["update"] },
} satisfies HandlerConfig;

const openDesktopEditSession = createHandler(
  config,
  async ({ body, scopedDb, session, user, workspaceId }) =>
    await openDesktopEditSessionHandler({
      body,
      organizationId: session.activeOrganizationId,
      scopedDb,
      userId: user.id,
      workspaceId,
    }),
);

export default openDesktopEditSession;
