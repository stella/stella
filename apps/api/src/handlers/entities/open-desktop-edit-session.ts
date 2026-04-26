import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { desktopEditSessions, entityVersions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tUuid } from "@/api/lib/custom-schema";
import {
  computeTokenExpiresAt,
  createDesktopEditSessionToken,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { broadcast } from "@/api/lib/sse";

import {
  presignDocxDownloadFromFileId,
  presignDocxFieldDownload,
  readCurrentDocxTarget,
  readVersionDocxTarget,
} from "./desktop-edit-session-utils";

const openDesktopEditSessionBodySchema = t.Object({
  entityId: tUuid,
  force: t.Optional(t.Boolean()),
  propertyId: tUuid,
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
  safeDb: SafeDb;
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
      tokenExpiresAt: computeTokenExpiresAt(),
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

const openDesktopEditSessionHandler = async function* ({
  body: { entityId, force, propertyId },
  organizationId,
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
        const existing = await tx
          .select({ id: desktopEditSessions.id })
          .from(desktopEditSessions)
          .where(
            and(
              eq(desktopEditSessions.entityId, entityId),
              eq(desktopEditSessions.propertyId, propertyId),
              eq(desktopEditSessions.workspaceId, workspaceId),
              eq(desktopEditSessions.status, "open"),
            ),
          )
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
        }
      }),
    );
  }

  const runOpenSession = async ({ allowInsert }: { allowInsert: boolean }) =>
    await safeDb(async (tx) => {
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
            statusCode: 400 as const,
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
        tokenExpiresAt: computeTokenExpiresAt(),
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

  let firstAttempt = await runOpenSession({ allowInsert: true });

  // Handle unique violation: retry without insert, then with insert
  if (Result.isError(firstAttempt)) {
    const error = firstAttempt.error;
    if ("cause" in error && isPgError(error.cause, PG_ERROR.UNIQUE_VIOLATION)) {
      const retryResult = await runOpenSession({ allowInsert: false });
      if (Result.isError(retryResult)) {
        return Result.err(
          new HandlerError({ status: 500, message: "Internal server error" }),
        );
      }
      if (retryResult.value === null) {
        return Result.err(
          new HandlerError({ status: 500, message: "Internal server error" }),
        );
      }
      firstAttempt = retryResult;
    } else {
      return Result.err(
        new HandlerError({ status: 500, message: "Internal server error" }),
      );
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
  async function* ({ body, safeDb, session, user, workspaceId }) {
    const result = yield* openDesktopEditSessionHandler({
      body,
      organizationId: session.activeOrganizationId,
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
