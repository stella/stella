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
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { issueFolioCollabToken } from "@/api/lib/folio-collab-sessions";

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
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const SEED_CLAIM_STALE_MS = 30_000;

const openFolioCollabSessionHandler = async function* ({
  body: { entityId, propertyId },
  organizationId,
  safeDb,
  userId,
  workspaceId,
}: OpenFolioCollabSessionProps) {
  const openSession = yield* Result.await(
    safeDb(async (tx) => {
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
            eq(desktopEditSessions.status, "open"),
            eq(desktopEditSessions.workspaceId, workspaceId),
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
        } as const;
      }

      const existingSessions = await tx
        .select({
          baseVersionId: folioCollabSessions.baseVersionId,
          fileName: folioCollabSessions.fileName,
          id: folioCollabSessions.id,
          seedClaimedAt: folioCollabSessions.seedClaimedAt,
          seededAt: folioCollabSessions.seededAt,
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
        if (existingSession.seededAt === null) {
          const seedClaimStale =
            existingSession.seedClaimedAt === null ||
            existingSession.seedClaimedAt.getTime() <
              Date.now() - SEED_CLAIM_STALE_MS;

          if (!seedClaimStale) {
            return {
              error: {
                message: "Collaborative edit session is still preparing.",
                status: 409,
              },
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
            } as const;
          }

          await tx
            .update(folioCollabSessions)
            .set({
              seedClaimedAt: new Date(),
              seedClaimedBy: userId,
            })
            .where(eq(folioCollabSessions.id, existingSession.id));

          return {
            baseVersionId: existingSession.baseVersionId,
            collabSessionId: existingSession.id,
            fileName: existingSession.fileName,
            seedDownloadUrl: presignDocxFieldDownload({
              fileContent: baseContent,
              organizationId,
              workspaceId,
            }),
            shouldSeed: true,
          } as const;
        }

        return {
          baseVersionId: existingSession.baseVersionId,
          collabSessionId: existingSession.id,
          fileName: existingSession.fileName,
          seedDownloadUrl: null,
          shouldSeed: false,
        } as const;
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
        } as const;
      }

      const collabSessionId = createSafeId<"folioCollabSession">();
      await tx.insert(folioCollabSessions).values({
        baseVersionId: currentTarget.baseVersionId,
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

      return {
        baseVersionId: currentTarget.baseVersionId,
        collabSessionId,
        fileName: currentTarget.fileContent.fileName,
        seedDownloadUrl: presignDocxFieldDownload({
          fileContent: currentTarget.fileContent,
          organizationId,
          workspaceId,
        }),
        shouldSeed: true,
      } as const;
    }),
  );

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
} satisfies HandlerConfig;

const openFolioCollabSession = createSafeHandler(
  config,
  async function* ({ body, safeDb, session, user, workspaceId }) {
    return yield* openFolioCollabSessionHandler({
      body,
      organizationId: session.activeOrganizationId,
      safeDb,
      userId: user.id,
      workspaceId,
    });
  },
);

export default openFolioCollabSession;
