import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { toFolioCollabRoomName } from "@stll/api-contract/folio-collab";
import { roles } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  folioCollabRooms,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import {
  lockDocxEditTarget,
  presignDocxFieldDownload,
  readCurrentDocxTarget,
  readVersionDocxTarget,
} from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FOLIO_COLLAB_SEED_CLAIM_STALE_MS } from "@/api/lib/folio-collab-room-contract";
import {
  canUseFolioCollabWorkspace,
  issueFolioCollabToken,
} from "@/api/lib/folio-collab-rooms";
import { isMemberRole } from "@/api/lib/member-roles";

const joinFolioCollabRoomBodySchema = t.Object({
  entityId: tSafeId("entity"),
  propertyId: tSafeId("property"),
});

type JoinFolioCollabRoomBody = Static<typeof joinFolioCollabRoomBodySchema>;

type JoinFolioCollabRoomResponse = {
  baseVersionId: SafeId<"entityVersion">;
  fileName: string;
  generation: number;
  roomId: SafeId<"folioCollabRoom">;
  roomName: string;
  seedDownloadUrl: string | null;
  shouldSeed: boolean;
  token: string;
  tokenExpiresAt: string;
};

type JoinFolioCollabRoomProps = {
  body: JoinFolioCollabRoomBody;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
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
      workspaceClientId: workspaces.clientId,
      workspaceMemberId: workspaceMembers.id,
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
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, member.userId),
        eq(workspaceMembers.workspaceId, workspaceId),
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
    workspaceClientId: membership.workspaceClientId,
    workspaceMemberId: membership.workspaceMemberId,
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

export const claimFolioCollabRoomSeed = async ({
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
      yjsSnapshotFileId: createSafeId<"userFile">(),
      yjsSnapshotSizeBytes: null,
      yjsSnapshotUpdatedAt: null,
    })
    .where(
      folioCollabSeedClaimPredicate({
        expectedGeneration,
        expectedSeedState,
        roomId,
        workspaceId,
      }),
    )
    .returning({ generation: folioCollabRooms.generation });

  return claimed.at(0) ?? null;
};

export const joinFolioCollabRoomHandler = async function* ({
  body: { entityId, propertyId },
  organizationId,
  recordAuditEvent,
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
          fileName: folioCollabRooms.fileName,
          generation: folioCollabRooms.generation,
          id: folioCollabRooms.id,
          seedClaimedAt: folioCollabRooms.seedClaimedAt,
          seedState: folioCollabRooms.seedState,
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
            fileName: folioCollabRooms.fileName,
            generation: folioCollabRooms.generation,
            id: folioCollabRooms.id,
            seedClaimedAt: folioCollabRooms.seedClaimedAt,
            seedState: folioCollabRooms.seedState,
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
      let generation = room.generation;
      let seedFileContent: Awaited<ReturnType<typeof readVersionDocxTarget>> =
        null;

      if (room.seedState !== "seeded") {
        const seedClaimDecision = decideFolioCollabSeedClaim({
          now,
          seedClaimedAt: room.seedClaimedAt,
          seedState: room.seedState,
        });
        if (seedClaimDecision === "preparing") {
          return {
            error: {
              message: "Collaborative editing room is still preparing.",
              status: 409,
            },
          } as const;
        }

        seedFileContent = await readVersionDocxTarget({
          entityVersionId: room.baseVersionId,
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
              message: "Collaborative room seed was claimed concurrently.",
              status: 409,
            },
          } as const;
        }

        generation = claim.generation;
        shouldSeed = true;
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
        generation,
        permissions: { canEdit: true },
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
      } as const;
    }),
  );

  if ("error" in joined) {
    return Result.err(
      new HandlerError({
        message: joined.error.message,
        status: joined.error.status,
      }),
    );
  }

  const seedDownloadUrl =
    joined.seedFileContent === null
      ? null
      : await presignDocxFieldDownload({
          fileContent: joined.seedFileContent,
          organizationId,
          workspaceId,
        });

  return Result.ok({
    baseVersionId: joined.baseVersionId,
    fileName: joined.fileName,
    generation: joined.generation,
    roomId: joined.roomId,
    roomName: toFolioCollabRoomName(joined.roomId),
    seedDownloadUrl,
    shouldSeed: joined.shouldSeed,
    token: joined.token,
    tokenExpiresAt: joined.tokenExpiresAt.toISOString(),
  } satisfies JoinFolioCollabRoomResponse);
};

const config = {
  body: joinFolioCollabRoomBodySchema,
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies HandlerConfig;

const joinFolioCollabRoom = createSafeHandler(
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
      body,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
      workspaceId,
    });
  },
);

export default joinFolioCollabRoom;
