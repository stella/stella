import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  FOLIO_COLLAB_SEED_PREPARING_CODE,
  toFolioCollabRoomName,
} from "@stll/api-contract/folio-collab";
import { roles } from "@stll/permissions";
import { Temporal } from "@stll/time";

import { member } from "@/api/db/auth-schema";
import { ownerSyntheticSessionAuthorityReader } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  desktopEditSessions,
  folioCollabRooms,
  workspaces,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { BUFFER_INTENT_STALE_MS } from "@/api/lib/buffer-intent-reconciliation";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import {
  lockDocxEditTarget,
  presignDocxFieldDownload,
  readCurrentDocxTarget,
  readVersionDocxTarget,
} from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { retireFolioCollabSnapshot } from "@/api/lib/files/folio-collab-snapshot-retirement";
import { createFileKey } from "@/api/lib/files/utils";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import { FOLIO_COLLAB_SEED_CLAIM_STALE_MS } from "@/api/lib/folio-collab-room-contract";
import {
  canUseFolioCollabWorkspace,
  issueFolioCollabToken,
  recordFolioCollabContribution,
} from "@/api/lib/folio-collab-rooms";
import { isMemberRole } from "@/api/lib/member-roles";
import { callerDownloadSource } from "@/api/lib/s3-presign";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

const joinFolioCollabRoomBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  propertyId: resourceIdSchema("property"),
});

type JoinFolioCollabRoomBody = v.InferOutput<
  typeof joinFolioCollabRoomBodySchema
>;

type JoinFolioCollabRoomResponse = {
  baseVersionId: SafeId<"entityVersion">;
  fileName: string;
  generation: number;
  roomId: SafeId<"folioCollabRoom">;
  roomName: string;
  snapshotRecovery: "none" | "unsaved-changes-discarded";
  seedDownloadUrl: string;
  shouldSeed: boolean;
  token: string;
  tokenExpiresAt: string;
};

type JoinFolioCollabRoomProps = {
  /** The browser session joining, or `null` for a credential that has none. */
  sourceSessionId: string | null;
  body: JoinFolioCollabRoomBody;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  readSessionAuthority: SyntheticSessionAuthorityReader;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const canStillEditWorkspace = async ({
  organizationId,
  tx,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}) => {
  const memberships = await tx
    .select({
      organizationRole: member.role,
      reachesMatter: memberReachesMatterSql(
        { organizationId, userId },
        workspaceId,
      ),
      workspaceStatus: workspaces.status,
    })
    .from(member)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
      ),
    )
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);

  const membership = memberships.at(0);
  if (
    !membership ||
    membership.workspaceStatus !== "active" ||
    !isMemberRole(membership.organizationRole)
  ) {
    return false;
  }

  const canUseWorkspace = canUseFolioCollabWorkspace({
    organizationRole: membership.organizationRole,
    reachesMatter: membership.reachesMatter,
  });
  return (
    canUseWorkspace &&
    roles[membership.organizationRole].authorize({ entity: ["update"] }).success
  );
};

type ClaimRoomSeedOptions = {
  expectedGeneration: number;
  expectedSeedState: "claimed" | "empty";
  now: Date;
  roomId: SafeId<"folioCollabRoom">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type SeedClaimPredicateOptions = Pick<
  ClaimRoomSeedOptions,
  "expectedGeneration" | "expectedSeedState" | "roomId" | "workspaceId"
>;

export const folioCollabSeedClaimPredicate = ({
  expectedGeneration,
  expectedSeedState,
  roomId,
  workspaceId,
}: SeedClaimPredicateOptions) =>
  and(
    eq(folioCollabRooms.id, roomId),
    eq(folioCollabRooms.workspaceId, workspaceId),
    eq(folioCollabRooms.seedState, expectedSeedState),
    eq(folioCollabRooms.generation, expectedGeneration),
  );

type SeedClaimDecisionInput = {
  now: Date;
  seedClaimedAt: Date | null;
  seedState: "claimed" | "empty" | "seeded";
};

export const decideFolioCollabSeedClaim = ({
  now,
  seedClaimedAt,
  seedState,
}: SeedClaimDecisionInput): "claimable" | "preparing" | "seeded" => {
  if (seedState === "seeded") {
    return "seeded";
  }
  if (seedState === "empty") {
    return "claimable";
  }
  if (
    seedClaimedAt !== null &&
    seedClaimedAt.getTime() >= now.getTime() - FOLIO_COLLAB_SEED_CLAIM_STALE_MS
  ) {
    return "preparing";
  }
  return "claimable";
};

/**
 * Whether the joining client seeds a room whose previous collaboration state
 * was discarded: either recovery reset a refused snapshot, or the room still
 * holds a snapshot it can no longer use.
 */
export const decideFolioCollabSnapshotRecovery = ({
  shouldSeed,
  snapshotRecovered,
  yjsSnapshotRevision,
}: {
  shouldSeed: boolean;
  snapshotRecovered: boolean;
  yjsSnapshotRevision: number;
}): JoinFolioCollabRoomResponse["snapshotRecovery"] =>
  shouldSeed && (snapshotRecovered || yjsSnapshotRevision > 0)
    ? "unsaved-changes-discarded"
    : "none";

const claimFolioCollabRoomSeed = async ({
  expectedGeneration,
  expectedSeedState,
  now,
  roomId,
  tx,
  userId,
  workspaceId,
}: ClaimRoomSeedOptions) => {
  // audit: skip — the join handler records every successful claim in this transaction
  const claimed = await tx
    .update(folioCollabRooms)
    .set({
      generation: sql`${folioCollabRooms.generation} + 1`,
      seedClaimedAt: now,
      seedClaimedBy: userId,
      seedState: "claimed",
      ...retireFolioCollabSnapshot({
        snapshotFileId: createSafeId<"userFile">(),
        state: "pending-seed",
        now,
      }),
      seededAt: null,
    })
    .where(
      folioCollabSeedClaimPredicate({
        expectedGeneration,
        expectedSeedState,
        roomId,
        workspaceId,
      }),
    )
    .returning({
      generation: folioCollabRooms.generation,
      snapshotRecoveredAt: folioCollabRooms.snapshotRecoveredAt,
      yjsSnapshotRevision: folioCollabRooms.yjsSnapshotRevision,
    });

  return claimed.at(0) ?? null;
};

const joinFolioCollabRoomHandler = async function* ({
  body: { entityId, propertyId },
  organizationId,
  sourceSessionId,
  recordAuditEvent,
  readSessionAuthority,
  safeDb,
  userId,
  workspaceId,
}: JoinFolioCollabRoomProps) {
  const joined = yield* Result.await(
    safeDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");

      await lockDocxEditTarget({
        entityId,
        propertyId,
        tx,
        workspaceId,
      });

      if (
        !(await canStillEditWorkspace({
          organizationId,
          tx,
          userId,
          workspaceId,
        }))
      ) {
        return {
          error: {
            message: "Collaborative edit access revoked.",
            status: 403,
          },
        } as const;
      }

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
            message: "This document has a desktop edit session open.",
            status: 409,
          },
        } as const;
      }

      const now = new Date();
      const rooms = await tx
        .select({
          baseVersionId: folioCollabRooms.baseVersionId,
          sourceVersionId: folioCollabRooms.sourceVersionId,
          fileName: folioCollabRooms.fileName,
          generation: folioCollabRooms.generation,
          id: folioCollabRooms.id,
          seedClaimedAt: folioCollabRooms.seedClaimedAt,
          seedState: folioCollabRooms.seedState,
          yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabRooms)
        .where(
          and(
            eq(folioCollabRooms.entityId, entityId),
            eq(folioCollabRooms.propertyId, propertyId),
            eq(folioCollabRooms.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      let room = rooms.at(0);
      if (!room) {
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

        const roomId = createSafeId<"folioCollabRoom">();
        const insertedRooms = await tx
          .insert(folioCollabRooms)
          .values({
            baseVersionId: currentTarget.baseVersionId,
            sourceVersionId: currentTarget.baseVersionId,
            docxCheckpointFileId: createSafeId<"userFile">(),
            entityId,
            fileName: currentTarget.fileContent.fileName,
            id: roomId,
            propertyId,
            workspaceId,
            yjsSnapshotFileId: createSafeId<"userFile">(),
          })
          .returning({
            baseVersionId: folioCollabRooms.baseVersionId,
            sourceVersionId: folioCollabRooms.sourceVersionId,
            fileName: folioCollabRooms.fileName,
            generation: folioCollabRooms.generation,
            id: folioCollabRooms.id,
            seedClaimedAt: folioCollabRooms.seedClaimedAt,
            seedState: folioCollabRooms.seedState,
            yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
            yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
          resourceId: roomId,
          changes: {
            created: {
              old: null,
              new: {
                baseVersionId: currentTarget.baseVersionId,
                sourceVersionId: currentTarget.baseVersionId,
                entityId,
                fileName: currentTarget.fileContent.fileName,
                propertyId,
              },
            },
          },
        });

        room = insertedRooms.at(0);
      }

      if (!room) {
        return {
          error: {
            message: "Collaborative editing room could not be created.",
            status: 409,
          },
        } as const;
      }

      let shouldSeed = false;
      let snapshotRecovery: JoinFolioCollabRoomResponse["snapshotRecovery"] =
        "none";
      let generation = room.generation;
      // Yjs paragraph tokens stay bound to the original DOCX across publications.
      const seedFileContent = await readVersionDocxTarget({
        entityVersionId: room.sourceVersionId,
        propertyId,
        tx,
        workspaceId,
      });
      if (!seedFileContent) {
        return {
          error: {
            message: "Collaborative room source file is no longer available.",
            status: 409,
          },
        } as const;
      }

      if (room.seedState !== "seeded") {
        const seedClaimDecision = decideFolioCollabSeedClaim({
          now,
          seedClaimedAt: room.seedClaimedAt,
          seedState: room.seedState,
        });
        if (seedClaimDecision === "preparing") {
          return {
            error: {
              code: FOLIO_COLLAB_SEED_PREPARING_CODE,
              message: "Collaborative editing room is still preparing.",
              status: 409,
            },
          } as const;
        }

        const claim = await claimFolioCollabRoomSeed({
          expectedGeneration: room.generation,
          expectedSeedState: room.seedState,
          now,
          roomId: room.id,
          tx,
          userId,
          workspaceId,
        });
        if (!claim) {
          return {
            error: {
              code: FOLIO_COLLAB_SEED_PREPARING_CODE,
              message: "Collaborative room seed was claimed concurrently.",
              status: 409,
            },
          } as const;
        }

        if (room.yjsSnapshotUpdatedAt !== null) {
          await tx.insert(bufferObjectCleanupIntents).values({
            id: createSafeId<"pendingUpload">(),
            nextAttemptAt: new Date(
              Temporal.Now.instant().epochMilliseconds + BUFFER_INTENT_STALE_MS,
            ),
            objectKey: createFileKey({
              fileId: room.yjsSnapshotFileId,
              mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
              organizationId,
              workspaceId,
            }),
            organizationId,
            status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
            workspaceId,
          });
        }

        generation = claim.generation;
        shouldSeed = true;
        snapshotRecovery = decideFolioCollabSnapshotRecovery({
          shouldSeed,
          snapshotRecovered: claim.snapshotRecoveredAt !== null,
          yjsSnapshotRevision: claim.yjsSnapshotRevision,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
          resourceId: room.id,
          changes: {
            generation: { old: room.generation, new: generation },
            seedState: { old: room.seedState, new: "claimed" },
          },
          metadata: {
            reason:
              room.seedState === "empty"
                ? "seed_claimed"
                : "stale_seed_claim_recovered",
          },
        });
      }

      const { token, tokenExpiresAt } = await issueFolioCollabToken({
        sourceSessionId,
        readSessionAuthority,
        generation,
        permissions: { canEdit: true },
        roomId: room.id,
        tx,
        userId,
        workspaceId,
      });
      await recordFolioCollabContribution({
        roomId: room.id,
        tx,
        userId,
        workspaceId,
      });

      return {
        baseVersionId: room.baseVersionId,
        fileName: room.fileName,
        generation,
        roomId: room.id,
        seedFileContent,
        shouldSeed,
        token,
        tokenExpiresAt,
        snapshotRecovery,
      } as const;
    }),
  );

  if ("error" in joined) {
    return Result.err(
      new HandlerError({
        message: joined.error.message,
        status: joined.error.status,
        ...("code" in joined.error ? { code: joined.error.code } : {}),
      }),
    );
  }

  const seedDownloadUrl = yield* Result.await(
    safeDb(
      async () =>
        await presignDocxFieldDownload({
          readSessionAuthority,
          userId,
          source: callerDownloadSource({ id: sourceSessionId }),
          fileContent: joined.seedFileContent,
          organizationId,
          workspaceId,
        }),
    ),
  );

  return Result.ok({
    baseVersionId: joined.baseVersionId,
    fileName: joined.fileName,
    generation: joined.generation,
    roomId: joined.roomId,
    roomName: toFolioCollabRoomName(joined.roomId),
    snapshotRecovery: joined.snapshotRecovery,
    seedDownloadUrl,
    shouldSeed: joined.shouldSeed,
    token: joined.token,
    tokenExpiresAt: joined.tokenExpiresAt.toISOString(),
  } satisfies JoinFolioCollabRoomResponse);
};

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Provides working-copy URLs covered by the collaboration-room lifecycle audit.",
  },
  body: joinFolioCollabRoomBodySchema,
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

export const createJoinFolioCollabRoom = (
  readSessionAuthority: SyntheticSessionAuthorityReader,
) =>
  createSafeHandler(
    config,
    async function* ({
      body,
      safeDb,
      session,
      user,
      workspaceId,
      recordAuditEvent,
    }) {
      return yield* joinFolioCollabRoomHandler({
        sourceSessionId: session.id,
        body,
        organizationId: session.activeOrganizationId,
        recordAuditEvent,
        readSessionAuthority,
        safeDb,
        userId: user.id,
        workspaceId,
      });
    },
  );

const joinFolioCollabRoom = createJoinFolioCollabRoom(
  ownerSyntheticSessionAuthorityReader,
);

export default joinFolioCollabRoom;
