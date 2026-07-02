import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { desktopEditSessions, folioCollabSessions } from "@/api/db/schema";
import {
  lockDocxEditTarget,
  presignDocxFieldDownload,
  readCurrentDocxTarget,
  readVersionDocxTarget,
} from "@/api/handlers/entities/desktop-edit-session-utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  collectFolioCollabStoredSessionFiles,
  deleteFolioCollabStoredSessionFiles,
  issueFolioCollabToken,
  isFolioCollabSessionExpired,
} from "@/api/lib/folio-collab-sessions";
import type { FolioCollabStoredSessionFile } from "@/api/lib/folio-collab-sessions";

const openFolioCollabSessionBodySchema = t.Object({
  entityId: tSafeId("entity"),
  propertyId: tSafeId("property"),
});

type OpenFolioCollabSessionBody = Static<
  typeof openFolioCollabSessionBodySchema
>;

type OpenFolioCollabSessionResponse = {
  baseVersionId: SafeId<"entityVersion">;
  collabSessionId: SafeId<"folioCollabSession">;
  fileName: string;
  roomName: string;
  seedDownloadUrl: string | null;
  shouldSeed: boolean;
  token: string;
  tokenExpiresAt: string;
};

type OpenFolioCollabSessionProps = {
  body: OpenFolioCollabSessionBody;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const SEED_CLAIM_STALE_MS = 30_000;

type ExpiredFolioCollabSessionFiles = {
  files: FolioCollabStoredSessionFile[];
  sessionId: SafeId<"folioCollabSession">;
};

const openFolioCollabSessionHandler = async function* ({
  body: { entityId, propertyId },
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
  workspaceId,
}: OpenFolioCollabSessionProps) {
  const openSession = yield* Result.await(
    safeDb(async (tx) => {
      let expiredSessionFiles: ExpiredFolioCollabSessionFiles | null = null;

      await lockDocxEditTarget({
        entityId,
        propertyId,
        tx,
        workspaceId,
      });

      const desktopSessions = await tx
        .select({ id: desktopEditSessions.id })
        .from(desktopEditSessions)
        .where(
          and(
            eq(desktopEditSessions.entityId, entityId),
            eq(desktopEditSessions.propertyId, propertyId),
            eq(desktopEditSessions.workspaceId, workspaceId),
            ...liveDesktopEditSessionPredicates(new Date()),
          ),
        )
        .limit(1);

      if (desktopSessions.at(0)) {
        return {
          error: {
            message:
              "This document already has a single-user edit session open.",
            status: 409,
          },
          expiredSessionFiles,
        } as const;
      }

      const now = new Date();
      const existingSessions = await tx
        .select({
          baseVersionId: folioCollabSessions.baseVersionId,
          createdAt: folioCollabSessions.createdAt,
          docxCheckpointFileId: folioCollabSessions.docxCheckpointFileId,
          docxCheckpointUpdatedAt: folioCollabSessions.docxCheckpointUpdatedAt,
          fileName: folioCollabSessions.fileName,
          id: folioCollabSessions.id,
          seedClaimedAt: folioCollabSessions.seedClaimedAt,
          seededAt: folioCollabSessions.seededAt,
          yjsSnapshotFileId: folioCollabSessions.yjsSnapshotFileId,
          yjsSnapshotUpdatedAt: folioCollabSessions.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabSessions)
        .where(
          and(
            eq(folioCollabSessions.entityId, entityId),
            eq(folioCollabSessions.propertyId, propertyId),
            eq(folioCollabSessions.status, "open"),
            eq(folioCollabSessions.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      const existingSession = existingSessions.at(0);
      if (existingSession) {
        if (isFolioCollabSessionExpired(existingSession.createdAt, now)) {
          expiredSessionFiles = {
            files: collectFolioCollabStoredSessionFiles(existingSession),
            sessionId: existingSession.id,
          };

          await tx
            .update(folioCollabSessions)
            .set({ closedAt: now, status: "cancelled" })
            .where(eq(folioCollabSessions.id, existingSession.id));

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_SESSION,
            resourceId: existingSession.id,
            changes: { status: { old: "open", new: "cancelled" } },
            metadata: { reason: "session_lifetime_expired" },
          });
        } else {
          if (existingSession.seededAt === null) {
            const seedClaimStale =
              existingSession.seedClaimedAt === null ||
              existingSession.seedClaimedAt.getTime() <
                now.getTime() - SEED_CLAIM_STALE_MS;

            if (!seedClaimStale) {
              return {
                error: {
                  message: "Collaborative edit session is still preparing.",
                  status: 409,
                },
                expiredSessionFiles,
              } as const;
            }

            const baseContent = await readVersionDocxTarget({
              entityVersionId: existingSession.baseVersionId,
              propertyId,
              tx,
              workspaceId,
            });

            if (!baseContent) {
              return {
                error: {
                  message:
                    "Collaborative edit session source file is no longer available.",
                  status: 409,
                },
                expiredSessionFiles,
              } as const;
            }

            await tx
              .update(folioCollabSessions)
              .set({
                seedClaimedAt: now,
                seedClaimedBy: userId,
              })
              .where(eq(folioCollabSessions.id, existingSession.id));

            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_SESSION,
              resourceId: existingSession.id,
              changes: {
                seedClaimedBy: { old: null, new: userId },
              },
              metadata: { reason: "seed_claim_recovered" },
            });

            return {
              baseVersionId: existingSession.baseVersionId,
              collabSessionId: existingSession.id,
              fileName: existingSession.fileName,
              sessionCreatedAt: existingSession.createdAt,
              seedDownloadUrl: await presignDocxFieldDownload({
                fileContent: baseContent,
                organizationId,
                workspaceId,
              }),
              shouldSeed: true,
              expiredSessionFiles,
            } as const;
          }

          return {
            baseVersionId: existingSession.baseVersionId,
            collabSessionId: existingSession.id,
            fileName: existingSession.fileName,
            sessionCreatedAt: existingSession.createdAt,
            seedDownloadUrl: null,
            shouldSeed: false,
            expiredSessionFiles,
          } as const;
        }
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
            status: 400,
          },
          expiredSessionFiles,
        } as const;
      }

      const collabSessionId = createSafeId<"folioCollabSession">();
      const sessionCreatedAt = new Date();
      await tx.insert(folioCollabSessions).values({
        baseVersionId: currentTarget.baseVersionId,
        createdAt: sessionCreatedAt,
        createdBy: userId,
        docxCheckpointFileId: createSafeId<"userFile">(),
        entityId,
        fileName: currentTarget.fileContent.fileName,
        id: collabSessionId,
        propertyId,
        seedClaimedAt: new Date(),
        seedClaimedBy: userId,
        workspaceId,
        yjsSnapshotFileId: createSafeId<"userFile">(),
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_SESSION,
        resourceId: collabSessionId,
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
        baseVersionId: currentTarget.baseVersionId,
        collabSessionId,
        fileName: currentTarget.fileContent.fileName,
        seedDownloadUrl: await presignDocxFieldDownload({
          fileContent: currentTarget.fileContent,
          organizationId,
          workspaceId,
        }),
        sessionCreatedAt,
        shouldSeed: true,
        expiredSessionFiles,
      } as const;
    }),
  );

  if (openSession.expiredSessionFiles !== null) {
    await deleteFolioCollabStoredSessionFiles({
      files: openSession.expiredSessionFiles.files,
      organizationId,
      sessionId: openSession.expiredSessionFiles.sessionId,
      workspaceId,
    });
  }

  if ("error" in openSession) {
    return Result.err(
      new HandlerError({
        message: openSession.error.message,
        status: openSession.error.status,
      }),
    );
  }

  const { token, tokenExpiresAt } = yield* Result.await(
    safeDb(
      async (tx) =>
        await issueFolioCollabToken({
          permissions: { canEdit: true },
          sessionCreatedAt: openSession.sessionCreatedAt,
          sessionId: openSession.collabSessionId,
          tx,
          userId,
          workspaceId,
        }),
    ),
  );

  return Result.ok({
    baseVersionId: openSession.baseVersionId,
    collabSessionId: openSession.collabSessionId,
    fileName: openSession.fileName,
    roomName: openSession.collabSessionId,
    seedDownloadUrl: openSession.seedDownloadUrl,
    shouldSeed: openSession.shouldSeed,
    token,
    tokenExpiresAt: tokenExpiresAt.toISOString(),
  } satisfies OpenFolioCollabSessionResponse);
};

const config = {
  body: openFolioCollabSessionBodySchema,
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies HandlerConfig;

const openFolioCollabSession = createSafeHandler(
  config,
  async function* ({
    body,
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    return yield* openFolioCollabSessionHandler({
      body,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
      workspaceId,
    });
  },
);

export default openFolioCollabSession;
