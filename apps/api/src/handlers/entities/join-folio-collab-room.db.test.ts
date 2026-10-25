import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import * as yProseMirror from "y-prosemirror";
import * as yjs from "yjs";

import { createHiddenEditorState } from "@stll/folio-core/controller/hiddenEditorManager";
import {
  createDocx,
  createEmptyDocument,
  extractDocxText,
  materializeYjsDocx,
  parseDocx,
} from "@stll/folio-core/server";
import { sha256Hex as legacyHex } from "@stll/sha256/node";

import { session } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  entities,
  entityVersions,
  fields,
  folioCollabPublications,
  folioCollabRooms,
  folioCollabRoomTokens,
  properties,
  syntheticSessionControl,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { resetFolioCollabUserState } from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { reserveObjectCleanupIntent } from "@/api/lib/buffer-intent-reconciliation";
import {
  loadPublicationPreliminary,
  publishCheckpointInTransaction,
} from "@/api/lib/entity-versions/publish-folio-collab-checkpoint";
import { createFileKey } from "@/api/lib/file-key";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { decideFolioSnapshotRecoveryState } from "@/api/lib/files/folio-collab-snapshot-loader";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import { FOLIO_COLLAB_SEED_CLAIM_STALE_MS } from "@/api/lib/folio-collab-room-contract";
import {
  acknowledgeFolioCollabSeed,
  authorizeFolioCollabRoom,
  cleanupExpiredFolioCollabRoomTokens,
  folioCollabSeedClaimLeaseOnHeartbeat,
  issueFolioCollabToken,
  loadFolioCollabSnapshot,
  storeFolioCollabSnapshot,
} from "@/api/lib/folio-collab-rooms";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_CONTROL_ID,
} from "@/api/lib/synthetic-principal/constants";
import { readSyntheticSessionAuthority } from "@/api/lib/synthetic-principal/session-authority";
import { createSyntheticSessionStore } from "@/api/lib/synthetic-principal/store";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { createCheckpointFolioCollabRoom } from "./checkpoint-folio-collab-room";
import joinFolioCollabRoom, {
  createJoinFolioCollabRoom,
  decideFolioCollabSeedClaim,
  decideFolioCollabSnapshotRecovery,
  folioCollabSeedClaimPredicate,
} from "./join-folio-collab-room";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: Awaited<ReturnType<typeof getRlsFixture>>["scopedQuery"];
let dryScopedQuery: Awaited<ReturnType<typeof getRlsFixture>>["dryScopedQuery"];
const roomIds: SafeId<"folioCollabRoom">[] = [];
const recoveryVersionIds: SafeId<"entityVersion">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
  dryScopedQuery = fixture.dryScopedQuery;
});

afterEach(async () => {
  if (roomIds.length === 0) {
    return;
  }
  await testDb
    .delete(folioCollabRooms)
    .where(inArray(folioCollabRooms.id, roomIds));
  roomIds.length = 0;
  if (recoveryVersionIds.length > 0) {
    await testDb
      .delete(entityVersions)
      .where(inArray(entityVersions.id, recoveryVersionIds));
    recoveryVersionIds.length = 0;
  }
});

afterAll(async () => {
  await releaseRlsFixture();
});

const insertRoom = async ({
  generation,
  seedClaimedAt,
  seedClaimedBy,
  seedState,
  seededAt,
  yjsSnapshotRevision,
  yjsSnapshotSizeBytes,
  yjsSnapshotUpdatedAt,
}: {
  generation: number;
  seedClaimedAt?: Date;
  seedClaimedBy?: SafeId<"user">;
  seedState: "claimed" | "empty" | "seeded";
  seededAt?: Date;
  yjsSnapshotRevision?: number;
  yjsSnapshotSizeBytes?: number | null;
  yjsSnapshotUpdatedAt?: Date | null;
}) => {
  const roomId = createSafeId<"folioCollabRoom">();
  const seeded = seedState === "seeded";
  const snapshotAt = new Date();
  roomIds.push(roomId);
  await testDb.insert(folioCollabRooms).values({
    baseVersionId: ids.entityVersionA1,
    sourceVersionId: ids.entityVersionA1,
    docxCheckpointFileId: createSafeId<"userFile">(),
    entityId: ids.entityA1,
    fileName: "contract.docx",
    generation,
    id: roomId,
    propertyId: ids.filePropertyA1,
    seedClaimedAt: seedClaimedAt ?? (seeded ? snapshotAt : undefined),
    seedClaimedBy,
    seedState,
    seededAt: seededAt ?? (seeded ? snapshotAt : undefined),
    workspaceId: ids.wsA1,
    yjsSnapshotFileId: createSafeId<"userFile">(),
    yjsSnapshotRevision: yjsSnapshotRevision ?? (seeded ? 1 : 0),
    yjsSnapshotSizeBytes: yjsSnapshotSizeBytes ?? (seeded ? 1 : null),
    yjsSnapshotUpdatedAt: yjsSnapshotUpdatedAt ?? (seeded ? snapshotAt : null),
  });
  return roomId;
};

const deployedSnapshot = (state: "clean" | "dirty") =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../lib/files/fixtures/folio-core-0.58.5/${state}.yjs`,
        import.meta.url,
      ),
    ),
  );

const claimConcurrently = async ({
  expectedGeneration,
  expectedSeedState,
  roomId,
}: {
  expectedGeneration: number;
  expectedSeedState: "claimed" | "empty";
  roomId: SafeId<"folioCollabRoom">;
}) =>
  await Promise.all(
    [ids.userA1, ids.userA2].map(
      async (userId) =>
        await testDb.transaction(async (tx) => {
          const claimed = await tx
            .update(folioCollabRooms)
            .set({
              generation: sql`${folioCollabRooms.generation} + 1`,
              seedClaimedAt: new Date(),
              seedClaimedBy: userId,
              seedState: "claimed",
            })
            .where(
              folioCollabSeedClaimPredicate({
                expectedGeneration,
                expectedSeedState,
                roomId,
                workspaceId: ids.wsA1,
              }),
            )
            .returning({ generation: folioCollabRooms.generation });
          return claimed.at(0) ?? null;
        }),
    ),
  );

test("a dedicated principal joins only while its dedicated session is live", async () => {
  await testDb
    .insert(syntheticSessionControl)
    .values({ id: SYNTHETIC_SESSION_CONTROL_ID, status: "enabled" })
    .onConflictDoUpdate({
      target: syntheticSessionControl.id,
      set: { status: "enabled" },
    });
  const store = createSyntheticSessionStore(asTestRaw(testDb));
  await store.revokeSyntheticSessions();
  await testDb
    .update(syntheticSessionControl)
    .set({ status: "enabled" })
    .where(eq(syntheticSessionControl.id, SYNTHETIC_SESSION_CONTROL_ID));
  await store.mintSyntheticSession({
    keyLabel: "join-fixture",
    requestId: undefined,
    userAgent: null,
  });
  const sourceSessions = await testDb
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, SYNTHETIC_PRINCIPAL.user.id))
    .limit(1);
  const sourceSession = sourceSessions.at(0);
  expect(sourceSession).toBeDefined();
  if (!sourceSession) {
    throw new Error("Dedicated session fixture was not created");
  }

  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  const fileId = createSafeId<"userFile">();
  const organizationId = brandPersistedOrganizationId(
    SYNTHETIC_PRINCIPAL.org.id,
  );
  const userId = brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id);
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Dedicated session fixture",
    reference: workspaceId,
  });
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await testDb
    .insert(entities)
    .values({ id: entityId, workspaceId, kind: "document", name: "Document" });
  await testDb
    .insert(entityVersions)
    .values({ id: entityVersionId, workspaceId, entityId });
  await testDb
    .update(entities)
    .set({ currentVersionId: entityVersionId })
    .where(eq(entities.id, entityId));
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  const sourceBytes = new Uint8Array(
    await createDocx(createEmptyDocument({ initialText: "Dedicated file." })),
  );
  await testDb.insert(fields).values({
    id: createSafeId<"field">(),
    entityVersionId,
    workspaceId,
    propertyId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: "dedicated.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: sourceBytes.byteLength,
      encrypted: false,
      sha256Hex: legacyHex(sourceBytes),
      pdfFileId: null,
    },
  });
  const scopedDb = asTestRaw<
    Parameters<typeof loadFolioCollabSnapshot>[0]["scopedDb"]
  >(
    async <T>(run: (tx: TestDatabaseTransaction) => Promise<T>) =>
      await scopedQuery([workspaceId], organizationId, run, userId),
  );
  const noAudit = async () => undefined;
  const join = async () => {
    const authority = await readSyntheticSessionAuthority(testDb, {
      sessionId: sourceSession.id,
      userId,
    });
    const dedicatedJoinHandler = createJoinFolioCollabRoom(
      async () => authority,
    );
    return await dedicatedJoinHandler.handler(
      asTestRaw<Parameters<typeof dedicatedJoinHandler.handler>[0]>({
        body: { entityId, propertyId },
        safeDb: safeDbFromScoped(scopedDb),
        session: { id: sourceSession.id, activeOrganizationId: organizationId },
        user: { id: userId, email: SYNTHETIC_PRINCIPAL.user.email },
        workspaceId,
        memberRole: sessionMemberRole("owner"),
        request: new Request("https://example.test/join"),
        route: "/v1/workspaces/:workspaceId/entities/join-folio-collab-room",
        recordAuditEvent: noAudit,
        createAuditRecorder: () => noAudit,
      }),
    );
  };
  const fake = startFakeS3();
  try {
    fake.put(
      envBase.S3_BUCKET,
      createFileKey({
        fileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId,
        workspaceId,
      }),
      sourceBytes,
      DOCX_MIME_TYPE,
    );
    const joined = await join();
    if (!("seedDownloadUrl" in joined)) {
      throw new Error("Dedicated principal did not join the room");
    }
    expect(typeof joined.token).toBe("string");
    expect(typeof joined.seedDownloadUrl).toBe("string");
    expect(
      Number(new URL(joined.seedDownloadUrl).searchParams.get("X-Amz-Expires")),
    ).toBeLessThanOrEqual(60);

    const authorization = await authorizeFolioCollabRoom({
      readSessionAuthority: async (options) =>
        await readSyntheticSessionAuthority(testDb, options),
      roomId: joined.roomId,
      token: joined.token,
      db: asTestRaw(testDb),
      createScopedDb: asTestRaw(() => scopedDb),
    });
    if (authorization.status !== "authorized") {
      throw new Error("Dedicated room token was not authorized");
    }
    const seeded = new yjs.Doc();
    createHiddenEditorState({
      document: await parseDocx(sourceBytes),
      collaboration: {
        shouldSeed: true,
        yXmlFragment: seeded.getXmlFragment("prosemirror"),
      },
      collaborationModules: { yjs, yProseMirror },
    });
    const snapshot = yjs.encodeStateAsUpdate(seeded);
    seeded.destroy();
    expect(
      (
        await acknowledgeFolioCollabSeed({
          value: authorization.value,
          snapshotSha256Hex: legacyHex(snapshot),
        })
      ).unwrap(),
    ).toEqual({ status: "acknowledged" });
    expect(
      (
        await storeFolioCollabSnapshot({
          authority: { type: "participant", userId },
          expectedGeneration: joined.generation,
          expectedSnapshotRevision: 0,
          snapshotBytes: snapshot,
          value: authorization.value,
        })
      ).unwrap(),
    ).toMatchObject({ status: "stored", snapshotRevision: 1 });
    const checkpoint = async () => {
      const authority = await readSyntheticSessionAuthority(testDb, {
        sessionId: sourceSession.id,
        userId,
      });
      const checkpointHandler = createCheckpointFolioCollabRoom(
        async () => authority,
      );
      return await checkpointHandler.handler(
        asTestRaw<Parameters<typeof checkpointHandler.handler>[0]>({
          body: {
            expectedGeneration: joined.generation,
            expectedSnapshotRevision: 1,
            roomId: joined.roomId,
          },
          safeDb: safeDbFromScoped(scopedDb),
          session: {
            id: sourceSession.id,
            activeOrganizationId: organizationId,
          },
          user: { id: userId, email: SYNTHETIC_PRINCIPAL.user.email },
          workspaceId,
          memberRole: sessionMemberRole("owner"),
          request: new Request("https://example.test/checkpoint"),
          route:
            "/v1/workspaces/:workspaceId/entities/checkpoint-folio-collab-room",
          recordAuditEvent: noAudit,
          createAuditRecorder: () => noAudit,
        }),
      );
    };
    const checkpointed = await checkpoint();
    if (!("downloadUrl" in checkpointed)) {
      throw new Error("Dedicated principal did not checkpoint the room");
    }
    expect(
      Number(
        new URL(checkpointed.downloadUrl).searchParams.get("X-Amz-Expires"),
      ),
    ).toBeLessThanOrEqual(60);

    await store.revokeSyntheticSessions();
    const refused = await checkpoint();
    expect(refused).toMatchObject({
      code: 403,
      response: { code: "account_access_unavailable" },
    });
  } finally {
    fake.stop();
    await testDb.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
});

describe("folio collaboration room ownership", () => {
  test("rejects base and source versions outside the room target", async () => {
    const variants = [
      {
        baseVersionId: ids.entityVersionA2,
        sourceVersionId: ids.entityVersionA1,
      },
      {
        baseVersionId: ids.entityVersionA1,
        sourceVersionId: ids.entityVersionA2,
      },
      {
        baseVersionId: ids.entityVersionB1,
        sourceVersionId: ids.entityVersionA1,
      },
      {
        baseVersionId: ids.entityVersionA1,
        sourceVersionId: ids.entityVersionB1,
      },
    ];

    for (const { baseVersionId, sourceVersionId } of variants) {
      const roomId = createSafeId<"folioCollabRoom">();
      roomIds.push(roomId);
      const rejection = await testDb
        .insert(folioCollabRooms)
        .values({
          baseVersionId,
          sourceVersionId,
          docxCheckpointFileId: createSafeId<"userFile">(),
          entityId: ids.entityA1,
          fileName: "contract.docx",
          id: roomId,
          propertyId: ids.filePropertyA1,
          workspaceId: ids.wsA1,
          yjsSnapshotFileId: createSafeId<"userFile">(),
        })
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toBeInstanceOf(Error);
      expect(String(rejection)).toContain(
        'Failed query: insert into "folio_collab_rooms"',
      );
    }
  });
});

describe("folio collaboration room seed generation CAS", () => {
  test("concurrent first claims elect exactly one seeder", async () => {
    const roomId = await insertRoom({ generation: 0, seedState: "empty" });

    const claims = await claimConcurrently({
      expectedGeneration: 0,
      expectedSeedState: "empty",
      roomId,
    });

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const rooms = await testDb
      .select({
        generation: folioCollabRooms.generation,
        seedState: folioCollabRooms.seedState,
      })
      .from(folioCollabRooms)
      .where(eq(folioCollabRooms.id, roomId))
      .limit(1);
    const room = rooms.at(0);
    expect(room).toMatchObject({ generation: 1, seedState: "claimed" });
  });

  test("stale-claim recovery also has one generation winner", async () => {
    const staleAt = new Date(Date.now() - FOLIO_COLLAB_SEED_CLAIM_STALE_MS - 1);
    const roomId = await insertRoom({
      generation: 1,
      seedClaimedAt: staleAt,
      seedClaimedBy: ids.userA1,
      seedState: "claimed",
    });

    const claims = await claimConcurrently({
      expectedGeneration: 1,
      expectedSeedState: "claimed",
      roomId,
    });

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const rooms = await testDb
      .select({ generation: folioCollabRooms.generation })
      .from(folioCollabRooms)
      .where(eq(folioCollabRooms.id, roomId))
      .limit(1);
    const room = rooms.at(0);
    expect(room?.generation).toBe(2);
  });

  test("a seeded room is never claimable again", async () => {
    const seededAt = new Date();
    expect(
      decideFolioCollabSeedClaim({
        now: seededAt,
        seedClaimedAt: seededAt,
        seedState: "seeded",
      }),
    ).toBe("seeded");
  });

  test("only the connected seed claimant renews its recovery lease", async () => {
    const claimedAt = new Date("2026-01-01T00:00:00.000Z");
    const touchedAt = new Date("2026-01-01T00:01:00.000Z");
    const roomId = await insertRoom({
      generation: 1,
      seedClaimedAt: claimedAt,
      seedClaimedBy: ids.userA1,
      seedState: "claimed",
    });

    const expectLeaseAfterHeartbeat = async ({
      expectedClaimedAt,
      userId,
    }: {
      expectedClaimedAt: Date;
      userId: SafeId<"user">;
    }) => {
      await testDb
        .update(folioCollabRooms)
        .set({
          seedClaimedAt: folioCollabSeedClaimLeaseOnHeartbeat({
            touchedAt,
            userId,
          }),
        })
        .where(eq(folioCollabRooms.id, roomId));
      const rooms = await testDb
        .select({ seedClaimedAt: folioCollabRooms.seedClaimedAt })
        .from(folioCollabRooms)
        .where(eq(folioCollabRooms.id, roomId))
        .limit(1);

      expect(rooms.at(0)?.seedClaimedAt).toEqual(expectedClaimedAt);
    };

    await expectLeaseAfterHeartbeat({
      expectedClaimedAt: claimedAt,
      userId: ids.userA2,
    });
    await expectLeaseAfterHeartbeat({
      expectedClaimedAt: touchedAt,
      userId: ids.userA1,
    });
  });

  test.each([
    { state: "clean", receiptOrder: "before-store", hashCut: "exact" },
    { state: "clean", receiptOrder: "after-store", hashCut: "exact" },
    { state: "dirty", receiptOrder: "before-store", hashCut: "exact" },
    { state: "dirty", receiptOrder: "after-store", hashCut: "exact" },
    { state: "clean", receiptOrder: "before-store", hashCut: "historical" },
    { state: "dirty", receiptOrder: "after-store", hashCut: "historical" },
    { state: "clean", receiptOrder: "before-store", hashCut: "stale-version" },
  ] as const)(
    "refused deployed $state snapshots with $hashCut cut reseed with receipt $receiptOrder",
    async ({ state, receiptOrder, hashCut }) => {
      const snapshotBytes = deployedSnapshot(state);
      const expectDiscardNotice = state === "dirty" || hashCut !== "exact";
      const seededAt = new Date(Date.now() + 1000);
      const snapshotAt = new Date(
        seededAt.getTime() + (state === "dirty" ? 1000 : 0),
      );
      const roomId = await insertRoom({
        generation: 4,
        seedClaimedBy: ids.userA1,
        seedState: "seeded",
        yjsSnapshotRevision: state === "dirty" ? 7 : 1,
        yjsSnapshotSizeBytes: snapshotBytes.byteLength,
        seededAt,
        yjsSnapshotUpdatedAt: snapshotAt,
      });
      const staleVersionId = createSafeId<"entityVersion">();
      const staleFileId = createSafeId<"userFile">();
      recoveryVersionIds.push(staleVersionId);
      await testDb.insert(entityVersions).values({
        id: staleVersionId,
        entityId: ids.entityA1,
        workspaceId: ids.wsA1,
        versionNumber: 2,
      });
      await testDb.insert(fields).values({
        id: createSafeId<"field">(),
        entityVersionId: staleVersionId,
        workspaceId: ids.wsA1,
        propertyId: ids.filePropertyA1,
        content: {
          version: 1,
          type: "file",
          id: staleFileId,
          fileName: "outdated.docx",
          mimeType: DOCX_MIME_TYPE,
          sizeBytes: 1,
          encrypted: false,
          sha256Hex: "a".repeat(64),
          pdfFileId: null,
        },
      });
      const oldCheckpointFileId = createSafeId<"userFile">();
      const oldCheckpointHash = "c".repeat(64);
      await testDb
        .update(folioCollabRooms)
        .set({
          docxCheckpointFileId: oldCheckpointFileId,
          docxCheckpointSha256Hex: oldCheckpointHash,
          docxCheckpointSnapshotSha256Hex: legacyHex(deployedSnapshot("clean")),
          docxCheckpointSizeBytes: 1,
          docxCheckpointUpdatedAt: new Date(),
          sourceVersionId:
            hashCut === "historical" ? ids.entityVersionA1 : staleVersionId,
          savedSnapshotCut:
            hashCut === "historical"
              ? null
              : {
                  versionId:
                    hashCut === "stale-version"
                      ? staleVersionId
                      : ids.entityVersionA1,
                  sha256Hex: legacyHex(deployedSnapshot("clean")),
                },
        })
        .where(eq(folioCollabRooms.id, roomId));
      const beforeRows = await testDb
        .select({
          baseVersionId: folioCollabRooms.baseVersionId,
          generation: folioCollabRooms.generation,
          seedClaimedAt: folioCollabRooms.seedClaimedAt,
          seedState: folioCollabRooms.seedState,
          seededAt: folioCollabRooms.seededAt,
          snapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
          snapshotSizeBytes: folioCollabRooms.yjsSnapshotSizeBytes,
          snapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabRooms)
        .where(eq(folioCollabRooms.id, roomId))
        .limit(1);
      const before = beforeRows.at(0);
      expect(before).toBeDefined();
      if (!before) {
        throw new Error("Expected the seeded room to be stored");
      }
      expect(before).toMatchObject({
        generation: 4,
        seedState: "seeded",
        snapshotRevision: state === "dirty" ? 7 : 1,
        snapshotSizeBytes: snapshotBytes.byteLength,
      });
      expect(before.seedClaimedAt).toBeInstanceOf(Date);
      expect(before.seededAt).toBeInstanceOf(Date);
      expect(before.snapshotUpdatedAt).toBeInstanceOf(Date);

      let readCount = 0;
      const scopedDb = asTestRaw<
        Parameters<typeof loadFolioCollabSnapshot>[0]["scopedDb"]
      >(
        async <T>(fn: (tx: TestDatabaseTransaction) => Promise<T>) =>
          await scopedQuery([ids.wsA1], ids.orgA, fn, ids.userA1),
      );
      const loadTarget = {
        organizationId: ids.orgA,
        roomId,
        scopedDb,
        workspaceId: ids.wsA1,
      };
      const readObject = async (_key: string, _signal: AbortSignal) => {
        readCount += 1;
        return new Uint8Array(snapshotBytes).buffer;
      };

      expect(
        (await loadFolioCollabSnapshot(loadTarget, readObject)).unwrap()
          ?.snapshot,
      ).toEqual({
        generation: 5,
        loadOutcome: "rematerialize-from-docx",
        resetGeneration: 4,
        snapshotBase64: null,
        snapshotRevision: 0,
      });

      const resetRows = await testDb
        .select({
          baseVersionId: folioCollabRooms.baseVersionId,
          generation: folioCollabRooms.generation,
          seedClaimedAt: folioCollabRooms.seedClaimedAt,
          seedClaimedBy: folioCollabRooms.seedClaimedBy,
          seedState: folioCollabRooms.seedState,
          seededAt: folioCollabRooms.seededAt,
          sourceVersionId: folioCollabRooms.sourceVersionId,
          checkpointFileId: folioCollabRooms.docxCheckpointFileId,
          checkpointSha256Hex: folioCollabRooms.docxCheckpointSha256Hex,
          checkpointSnapshotSha256Hex:
            folioCollabRooms.docxCheckpointSnapshotSha256Hex,
          checkpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
          snapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
          snapshotSizeBytes: folioCollabRooms.yjsSnapshotSizeBytes,
          snapshotRecoveredAt: folioCollabRooms.snapshotRecoveredAt,
          snapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabRooms)
        .where(eq(folioCollabRooms.id, roomId))
        .limit(1);
      const reset = resetRows.at(0);
      if (expectDiscardNotice) {
        expect(reset?.snapshotRecoveredAt).toBeInstanceOf(Date);
      } else {
        expect(reset?.snapshotRecoveredAt).toBeNull();
      }
      // The reset revision is 0, so only the recovery marker can tell the
      // client that seeds the room next that unsaved changes were discarded.
      expect(
        decideFolioCollabSnapshotRecovery({
          shouldSeed: true,
          snapshotRecovered: reset?.snapshotRecoveredAt instanceof Date,
          yjsSnapshotRevision: reset?.snapshotRevision ?? -1,
        }),
      ).toBe(expectDiscardNotice ? "unsaved-changes-discarded" : "none");
      expect(reset).toMatchObject({
        baseVersionId: before.baseVersionId,
        generation: 5,
        seedClaimedAt: null,
        seedClaimedBy: null,
        seedState: "empty",
        seededAt: null,
        sourceVersionId: before.baseVersionId,
        snapshotRevision: 0,
        snapshotSizeBytes: null,
        snapshotUpdatedAt: null,
      });
      expect(reset?.snapshotFileId).not.toBe(before.snapshotFileId);
      expect(reset?.checkpointFileId).not.toBe(oldCheckpointFileId);
      expect(reset).toMatchObject({
        checkpointSha256Hex: null,
        checkpointSnapshotSha256Hex: null,
        checkpointUpdatedAt: null,
      });
      expect(
        await scopedDb(
          async (tx) =>
            await publishCheckpointInTransaction({
              body: {
                roomId,
                expectedGeneration: 5,
                expectedSha256Hex: oldCheckpointHash,
                idempotencyKey: Bun.randomUUIDv7(),
              },
              checkpointKey: createFileKey({
                fileId: oldCheckpointFileId,
                mimeType: DOCX_MIME_TYPE,
                organizationId: ids.orgA,
                workspaceId: ids.wsA1,
              }),
              checkpointRoom: {
                checkpointFileId: oldCheckpointFileId,
                checkpointSha256Hex: oldCheckpointHash,
                checkpointSnapshotSha256Hex: legacyHex(
                  deployedSnapshot("clean"),
                ),
                checkpointSizeBytes: 1,
                checkpointScanWarnings: null,
                checkpointUpdatedAt: new Date(),
                entityId: ids.entityA1,
                fileName: "contract.docx",
                generation: 4,
                propertyId: ids.filePropertyA1,
              },
              organizationId: ids.orgA,
              recordAuditEvent: async () => undefined,
              source: {
                cleanupIntentId: createSafeId<"pendingUpload">(),
                fileId: allocateFileObject(),
                key: "unused",
                organizationId: ids.orgA,
              },
              storedSha256Hex: oldCheckpointHash,
              storedSizeBytes: 1,
              tx,
              userId: ids.userA1,
              workspaceId: ids.wsA1,
            }),
        ),
      ).toEqual({ status: "checkpoint-changed" });
      expect(readCount).toBe(1);

      expect(
        (await loadFolioCollabSnapshot(loadTarget, readObject)).unwrap()
          ?.snapshot,
      ).toEqual({
        generation: 5,
        loadOutcome: "loaded",
        snapshotBase64: null,
        snapshotRevision: 0,
      });
      expect(readCount).toBe(1);

      const savedDocx = new Uint8Array(
        readFileSync(
          new URL(
            "../../lib/files/fixtures/folio-core-0.58.5/saved.docx",
            import.meta.url,
          ),
        ),
      );
      const fake = startFakeS3();
      try {
        const sourceKey = (fileId: string) =>
          createFileKey({
            fileId,
            mimeType: DOCX_MIME_TYPE,
            organizationId: ids.orgA,
            workspaceId: ids.wsA1,
          });
        fake.put(
          envBase.S3_BUCKET,
          sourceKey(ids.fileObjectA1),
          savedDocx,
          DOCX_MIME_TYPE,
        );
        fake.put(
          envBase.S3_BUCKET,
          sourceKey(staleFileId),
          new Uint8Array(
            await createDocx(
              createEmptyDocument({ initialText: "Outdated source." }),
            ),
          ),
          DOCX_MIME_TYPE,
        );
        const noAudit = async () => undefined;
        const join = async () =>
          await joinFolioCollabRoom.handler(
            asTestRaw<Parameters<typeof joinFolioCollabRoom.handler>[0]>({
              body: { entityId: ids.entityA1, propertyId: ids.filePropertyA1 },
              safeDb: safeDbFromScoped(scopedDb),
              session: {
                id: "fixture-session",
                activeOrganizationId: ids.orgA,
              },
              user: { id: ids.userA1, email: "editor@example.test" },
              workspaceId: ids.wsA1,
              memberRole: sessionMemberRole("owner"),
              request: new Request("https://example.test/join"),
              route:
                "/v1/workspaces/:workspaceId/entities/join-folio-collab-room",
              recordAuditEvent: noAudit,
              createAuditRecorder: () => noAudit,
            }),
          );
        const joined = await join();
        expect(joined).toMatchObject({
          roomId,
          generation: 6,
          shouldSeed: true,
          snapshotRecovery: expectDiscardNotice
            ? "unsaved-changes-discarded"
            : "none",
        });
        if (!("shouldSeed" in joined)) {
          throw new Error("Recovered room did not return a successful join");
        }
        const authorization = await authorizeFolioCollabRoom({
          readSessionAuthority: async (options) =>
            await readSyntheticSessionAuthority(testDb, options),
          roomId,
          token: joined.token,
          db: asTestRaw<
            NonNullable<Parameters<typeof authorizeFolioCollabRoom>[0]["db"]>
          >(testDb),
          createScopedDb: asTestRaw<
            NonNullable<
              Parameters<typeof authorizeFolioCollabRoom>[0]["createScopedDb"]
            >
          >(() => scopedDb),
        });
        if (authorization.status !== "authorized") {
          throw new Error("Recovered room token was not authorized");
        }
        expect(await join()).toMatchObject({ code: 409 });
        const download = await fetch(joined.seedDownloadUrl);
        expect(download.status).toBe(200);
        const seedBytes = new Uint8Array(await download.arrayBuffer());
        expect(seedBytes).toEqual(savedDocx);
        const reseeded = new yjs.Doc();
        const editorState = createHiddenEditorState({
          document: await parseDocx(seedBytes),
          collaboration: {
            shouldSeed: joined.shouldSeed,
            yXmlFragment: reseeded.getXmlFragment("prosemirror"),
          },
          collaborationModules: { yjs, yProseMirror },
        });
        expect(editorState.doc.textContent).toBe(
          "Saved contract. Článek první.",
        );
        const snapshot = yjs.encodeStateAsUpdate(reseeded);
        reseeded.destroy();
        const materialized = await materializeYjsDocx({
          sourceDocx: seedBytes,
          yjsUpdate: snapshot,
        });
        expect(await extractDocxText(materialized)).toEqual(
          await extractDocxText(savedDocx),
        );
        const receipt = {
          value: authorization.value,
          snapshotSha256Hex: legacyHex(snapshot),
        };
        expect(
          (
            await acknowledgeFolioCollabSeed({
              ...receipt,
              value: {
                ...authorization.value,
                generation: joined.generation - 1,
              },
            })
          ).unwrap(),
        ).toEqual({ status: "seed-changed" });
        expect(
          (
            await acknowledgeFolioCollabSeed({
              ...receipt,
              value: { ...authorization.value, userId: ids.userA2 },
            })
          ).unwrap(),
        ).toEqual({ status: "seed-changed" });
        if (receiptOrder === "before-store") {
          expect((await acknowledgeFolioCollabSeed(receipt)).unwrap()).toEqual({
            status: "acknowledged",
          });
          expect(await join()).toMatchObject({ code: 409 });
        }
        expect(
          (
            await storeFolioCollabSnapshot({
              authority: { type: "participant", userId: ids.userA1 },
              expectedGeneration: joined.generation,
              expectedSnapshotRevision: 0,
              snapshotBytes: snapshot,
              value: loadTarget,
            })
          ).unwrap(),
        ).toMatchObject({ status: "stored", snapshotRevision: 1 });
        if (receiptOrder === "after-store") {
          expect(await join()).toMatchObject({ code: 409 });
          expect((await acknowledgeFolioCollabSeed(receipt)).unwrap()).toEqual({
            status: "acknowledged",
          });
        }
        expect((await acknowledgeFolioCollabSeed(receipt)).unwrap()).toEqual({
          status: "acknowledged",
        });
        expect(
          (
            await acknowledgeFolioCollabSeed({
              ...receipt,
              snapshotSha256Hex: "0".repeat(64),
            })
          ).unwrap(),
        ).toEqual({ status: "seed-changed" });
        expect(await join()).toMatchObject({
          roomId,
          shouldSeed: false,
          snapshotRecovery: "none",
        });
        expect(
          (
            await storeFolioCollabSnapshot({
              authority: { type: "collab-service" },
              expectedGeneration: joined.generation,
              expectedSnapshotRevision: 1,
              snapshotBytes: snapshot,
              value: loadTarget,
            })
          ).unwrap(),
        ).toMatchObject({ status: "stored", snapshotRevision: 2 });
        const seededRooms = await testDb
          .select({
            snapshotRecoveredAt: folioCollabRooms.snapshotRecoveredAt,
            savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
          })
          .from(folioCollabRooms)
          .where(eq(folioCollabRooms.id, roomId));
        expect(seededRooms.at(0)).toEqual({
          snapshotRecoveredAt: null,
          savedSnapshotCut: {
            versionId: ids.entityVersionA1,
            sha256Hex: legacyHex(snapshot),
          },
        });
      } finally {
        fake.stop();
      }
    },
  );
});

test("edits in the first durable snapshot remain unsaved after the pristine seed receipt", async () => {
  const roomId = await insertRoom({
    generation: 4,
    seedState: "claimed",
    seedClaimedBy: ids.userA1,
    seedClaimedAt: new Date(),
  });
  const scopedDb = asTestRaw<
    Parameters<typeof loadFolioCollabSnapshot>[0]["scopedDb"]
  >(
    async <T>(run: (tx: TestDatabaseTransaction) => Promise<T>) =>
      await scopedQuery([ids.wsA1], ids.orgA, run, ids.userA1),
  );
  const value = {
    canEdit: true,
    entityId: ids.entityA1,
    fileName: "contract.docx",
    generation: 4,
    organizationId: ids.orgA,
    propertyId: ids.filePropertyA1,
    roomId,
    scopedDb,
    sourceSessionExpiresAt: null,
    tokenExpiresAt: new Date(Date.now() + 60_000),
    tokenId: createSafeId<"folioCollabRoomToken">(),
    userId: ids.userA1,
    userName: "Editor",
    workspaceId: ids.wsA1,
  };
  const fake = startFakeS3();
  try {
    expect(
      (
        await storeFolioCollabSnapshot({
          authority: { type: "collab-service" },
          expectedGeneration: 4,
          expectedSnapshotRevision: 0,
          snapshotBytes: deployedSnapshot("dirty"),
          value,
        })
      ).unwrap(),
    ).toMatchObject({ status: "stored", snapshotRevision: 1 });
    const pending = await testDb
      .select({
        seedState: folioCollabRooms.seedState,
        savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
        seededAt: folioCollabRooms.seededAt,
      })
      .from(folioCollabRooms)
      .where(eq(folioCollabRooms.id, roomId));
    expect(pending.at(0)).toEqual({
      seedState: "claimed",
      savedSnapshotCut: null,
      seededAt: null,
    });
    expect(
      (
        await acknowledgeFolioCollabSeed({
          value,
          snapshotSha256Hex: legacyHex(deployedSnapshot("clean")),
        })
      ).unwrap(),
    ).toEqual({ status: "acknowledged" });
    expect(
      (await loadFolioCollabSnapshot(value)).unwrap()?.snapshot,
    ).toMatchObject({ generation: 5, loadOutcome: "rematerialize-from-docx" });
    const recovered = await testDb
      .select({ snapshotRecoveredAt: folioCollabRooms.snapshotRecoveredAt })
      .from(folioCollabRooms)
      .where(eq(folioCollabRooms.id, roomId));
    expect(recovered.at(0)?.snapshotRecoveredAt).toBeInstanceOf(Date);
  } finally {
    fake.stop();
  }
});

test("publishing a checkpoint retains its snapshot cut when later edits already exist", async () => {
  const roomId = await insertRoom({
    generation: 4,
    seedState: "seeded",
    seedClaimedBy: ids.userA1,
  });
  await dryScopedQuery(
    [ids.wsA1],
    ids.orgA,
    async (tx) => {
      const publicationTx =
        asTestRaw<Parameters<typeof publishCheckpointInTransaction>[0]["tx"]>(
          tx,
        );
      const checkpointHash = "c".repeat(64);
      const savedSnapshotHash = legacyHex(deployedSnapshot("clean"));
      const newerSnapshotHash = legacyHex(deployedSnapshot("dirty"));
      const checkpointFileId = createSafeId<"userFile">();
      const sourceFileId = allocateFileObject();
      const sourceKey = createFileKey({
        fileId: sourceFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
      });
      const safeDb = safeDbFromScoped(async (run) => await run(publicationTx));
      const cleanupIntentId = (
        await reserveObjectCleanupIntent({
          objectKey: sourceKey,
          organizationId: ids.orgA,
          safeDb,
          workspaceId: ids.wsA1,
        })
      ).unwrap();
      await tx
        .update(folioCollabRooms)
        .set({
          docxCheckpointFileId: checkpointFileId,
          docxCheckpointSha256Hex: checkpointHash,
          docxCheckpointSnapshotSha256Hex: savedSnapshotHash,
          docxCheckpointSizeBytes: 1,
          docxCheckpointUpdatedAt: new Date(),
          savedSnapshotCut: {
            versionId: ids.entityVersionA1,
            sha256Hex: savedSnapshotHash,
          },
          yjsSnapshotRevision: 2,
          yjsSnapshotSizeBytes: deployedSnapshot("dirty").byteLength,
          yjsSnapshotUpdatedAt: new Date(),
        })
        .where(eq(folioCollabRooms.id, roomId));
      const cut = {
        roomId,
        expectedGeneration: 4,
        expectedSha256Hex: checkpointHash,
        idempotencyKey: Bun.randomUUIDv7(),
      };
      const preliminary = await loadPublicationPreliminary({
        cut,
        tx: publicationTx,
        workspaceId: ids.wsA1,
      });
      if (preliminary.status !== "checkpoint") {
        throw new Error("Expected the captured checkpoint before publication");
      }
      const published = await publishCheckpointInTransaction({
        body: cut,
        checkpointKey: createFileKey({
          fileId: checkpointFileId,
          mimeType: DOCX_MIME_TYPE,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
        }),
        checkpointRoom: preliminary.room,
        organizationId: ids.orgA,
        recordAuditEvent: async () => undefined,
        source: {
          cleanupIntentId,
          fileId: sourceFileId,
          key: sourceKey,
          organizationId: ids.orgA,
        },
        storedSha256Hex: checkpointHash,
        storedSizeBytes: 1,
        tx: publicationTx,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      });
      expect(published.status).toBe("created");
      if (published.status !== "created") {
        throw new Error("Expected the captured checkpoint to publish");
      }
      const rooms = await tx
        .select({
          savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
          snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
        })
        .from(folioCollabRooms)
        .where(eq(folioCollabRooms.id, roomId));
      expect(rooms.at(0)).toEqual({
        savedSnapshotCut: {
          versionId: published.versionId,
          sha256Hex: savedSnapshotHash,
        },
        snapshotRevision: 2,
      });
      const publications = await tx
        .select({
          snapshotSha256Hex: folioCollabPublications.snapshotSha256Hex,
        })
        .from(folioCollabPublications)
        .where(eq(folioCollabPublications.roomId, roomId));
      expect(publications).toEqual([{ snapshotSha256Hex: savedSnapshotHash }]);
      expect(
        decideFolioSnapshotRecoveryState({
          savedSnapshotCut: rooms.at(0)?.savedSnapshotCut ?? null,
          savedVersionId: published.versionId,
          snapshotSha256Hex: newerSnapshotHash,
          snapshotUpdatedAt: new Date(1),
          savedVersionCreatedAt: new Date(3),
          seededAt: new Date(0),
          historicalBaseline: "publication",
        }),
      ).toBe("unsaved");
    },
    ids.userA1,
  );
});

describe("stale pending seed recovery notices", () => {
  test.each(["version-bound", "missing", "stale-version"] as const)(
    "preserves the discard notice across successive stale reclaims with a %s saved cut",
    async (cutState) => {
      const staleAt = new Date(
        Date.now() - FOLIO_COLLAB_SEED_CLAIM_STALE_MS - 1,
      );
      const roomId = await insertRoom({
        generation: 4,
        seedClaimedAt: staleAt,
        seedClaimedBy: ids.userA1,
        seedState: "claimed",
        yjsSnapshotRevision: 3,
        yjsSnapshotSizeBytes: 1,
        yjsSnapshotUpdatedAt: staleAt,
      });
      if (cutState !== "missing") {
        await testDb
          .update(folioCollabRooms)
          .set({
            savedSnapshotCut: {
              versionId:
                cutState === "version-bound"
                  ? ids.entityVersionA1
                  : createSafeId<"entityVersion">(),
              sha256Hex: "a".repeat(64),
            },
          })
          .where(eq(folioCollabRooms.id, roomId));
      }
      const scopedDb = asTestRaw<
        Parameters<typeof loadFolioCollabSnapshot>[0]["scopedDb"]
      >(
        async <T>(run: (tx: TestDatabaseTransaction) => Promise<T>) =>
          await scopedQuery([ids.wsA1], ids.orgA, run, ids.userA1),
      );
      const fake = startFakeS3();
      try {
        const noAudit = async () => undefined;
        const join = async () =>
          await joinFolioCollabRoom.handler(
            asTestRaw<Parameters<typeof joinFolioCollabRoom.handler>[0]>({
              body: { entityId: ids.entityA1, propertyId: ids.filePropertyA1 },
              safeDb: safeDbFromScoped(scopedDb),
              session: {
                id: "fixture-session",
                activeOrganizationId: ids.orgA,
              },
              user: { id: ids.userA1, email: "editor@example.test" },
              workspaceId: ids.wsA1,
              memberRole: sessionMemberRole("owner"),
              request: new Request("https://example.test/join"),
              route:
                "/v1/workspaces/:workspaceId/entities/join-folio-collab-room",
              recordAuditEvent: noAudit,
              createAuditRecorder: () => noAudit,
            }),
          );
        const joined = await join();
        expect(joined).toMatchObject({
          roomId,
          generation: 5,
          shouldSeed: true,
          snapshotRecovery:
            cutState === "version-bound" ? "none" : "unsaved-changes-discarded",
        });
        const rooms = await testDb
          .select({
            snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
            savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
            snapshotRecoveredAt: folioCollabRooms.snapshotRecoveredAt,
          })
          .from(folioCollabRooms)
          .where(eq(folioCollabRooms.id, roomId));
        expect(rooms.at(0)).toEqual({
          snapshotRevision: 0,
          savedSnapshotCut: null,
          snapshotRecoveredAt:
            cutState === "version-bound" ? null : expect.any(Date),
        });

        // The claimant closes before reseeding; a second stale join must retain the loss notice.
        await testDb
          .update(folioCollabRooms)
          .set({ seedClaimedAt: staleAt })
          .where(eq(folioCollabRooms.id, roomId));
        const reclaimed = await join();
        expect(reclaimed).toMatchObject({
          roomId,
          generation: 6,
          shouldSeed: true,
          snapshotRecovery:
            cutState === "version-bound" ? "none" : "unsaved-changes-discarded",
        });
        const reclaimedRooms = await testDb
          .select({
            snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
            savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
            snapshotRecoveredAt: folioCollabRooms.snapshotRecoveredAt,
          })
          .from(folioCollabRooms)
          .where(eq(folioCollabRooms.id, roomId));
        expect(reclaimedRooms).toEqual(rooms);
      } finally {
        fake.stop();
      }
    },
  );
});

describe("folio collaboration snapshot recovery notice", () => {
  test("only a seeding join after discarded state reports the loss", () => {
    const cases = [
      { shouldSeed: true, snapshotRecovered: true, yjsSnapshotRevision: 0 },
      { shouldSeed: true, snapshotRecovered: false, yjsSnapshotRevision: 3 },
      { shouldSeed: true, snapshotRecovered: true, yjsSnapshotRevision: 3 },
      { shouldSeed: true, snapshotRecovered: false, yjsSnapshotRevision: 0 },
      { shouldSeed: false, snapshotRecovered: true, yjsSnapshotRevision: 0 },
      { shouldSeed: false, snapshotRecovered: false, yjsSnapshotRevision: 3 },
    ] as const;
    expect(
      cases.map((input) => decideFolioCollabSnapshotRecovery(input)),
    ).toEqual([
      "unsaved-changes-discarded",
      "unsaved-changes-discarded",
      "unsaved-changes-discarded",
      "none",
      "none",
      "none",
    ]);
  });
});

describe("folio collaboration room token retention", () => {
  test("expiry cleanup removes one bounded page of tokens", async () => {
    const generation = 1;
    const roomId = await insertRoom({ generation, seedState: "empty" });
    const oldestExpiredAtMs = Date.UTC(2000, 0, 1);
    await testDb.insert(folioCollabRoomTokens).values(
      Array.from({ length: 101 }, (_, index) => ({
        expiresAt: new Date(oldestExpiredAtMs + index),
        generation,
        id: createSafeId<"folioCollabRoomToken">(),
        permissions: { canEdit: true },
        roomId,
        tokenHash: index.toString(16).padStart(64, "0"),
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      })),
    );

    await cleanupExpiredFolioCollabRoomTokens({
      db: testDb,
      workspaceId: ids.wsA1,
    });

    const remainingExpired = await testDb
      .select({ id: folioCollabRoomTokens.id })
      .from(folioCollabRoomTokens)
      .where(
        and(
          eq(folioCollabRoomTokens.roomId, roomId),
          lt(folioCollabRoomTokens.expiresAt, new Date()),
        ),
      );
    expect(remainingExpired).toHaveLength(1);
  });
});

test("issued collaboration tokens store the legacy createHash digest", async () => {
  const roomId = await insertRoom({ generation: 0, seedState: "empty" });
  const { token } = await testDb.transaction(async (tx) =>
    issueFolioCollabToken({
      sourceSessionId: "ordinary-session",
      readSessionAuthority: async () => null,
      generation: 0,
      permissions: { canEdit: true },
      roomId,
      tx,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    }),
  );
  const stored = await testDb
    .select({
      tokenHash: folioCollabRoomTokens.tokenHash,
      sourceSessionId: folioCollabRoomTokens.sourceSessionId,
    })
    .from(folioCollabRoomTokens)
    .where(eq(folioCollabRoomTokens.roomId, roomId));
  expect(stored).toEqual([
    { tokenHash: legacyHex(token), sourceSessionId: null },
  ]);
});

test("deleting a claimant before seed acknowledgement warns the next member about discarded edits", async () => {
  const roomId = await insertRoom({
    generation: 4,
    seedState: "claimed",
    seedClaimedAt: new Date(),
    seedClaimedBy: ids.userA1,
  });
  const scopedDb = asTestRaw<
    Parameters<typeof loadFolioCollabSnapshot>[0]["scopedDb"]
  >(
    async <T>(run: (tx: TestDatabaseTransaction) => Promise<T>) =>
      await scopedQuery([ids.wsA1], ids.orgA, run, ids.userA1),
  );
  const fake = startFakeS3();
  const membershipId = createSafeId<"workspaceMember">();
  let retiredKey: string | undefined;
  try {
    await testDb.insert(workspaceMembers).values({
      id: membershipId,
      userId: ids.userA2,
      workspaceId: ids.wsA1,
    });
    const stored = await storeFolioCollabSnapshot({
      authority: { type: "collab-service" },
      expectedGeneration: 4,
      expectedSnapshotRevision: 0,
      snapshotBytes: deployedSnapshot("dirty"),
      value: {
        organizationId: ids.orgA,
        roomId,
        scopedDb,
        workspaceId: ids.wsA1,
      },
    });
    expect(stored.unwrap()).toMatchObject({
      status: "stored",
      snapshotRevision: 1,
    });
    const [pending] = await testDb
      .select()
      .from(folioCollabRooms)
      .where(eq(folioCollabRooms.id, roomId));
    if (!pending) {
      throw new TypeError("Pending seed fixture room is missing");
    }
    expect(pending).toMatchObject({
      seedState: "claimed",
      savedSnapshotCut: null,
      seededAt: null,
      yjsSnapshotRevision: 1,
    });
    retiredKey = createFileKey({
      fileId: pending.yjsSnapshotFileId,
      mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
    });
    await testDb.transaction(
      async (tx) =>
        await resetFolioCollabUserState(
          asTestRaw<Parameters<typeof resetFolioCollabUserState>[0]>(tx),
          ids.userA1,
        ),
    );
    const nextMemberDb = asTestRaw<
      Parameters<typeof loadFolioCollabSnapshot>[0]["scopedDb"]
    >(
      async <T>(run: (tx: TestDatabaseTransaction) => Promise<T>) =>
        await scopedQuery([ids.wsA1], ids.orgA, run, ids.userA2),
    );
    const noAudit = async () => undefined;
    const joined = await joinFolioCollabRoom.handler(
      asTestRaw<Parameters<typeof joinFolioCollabRoom.handler>[0]>({
        body: { entityId: ids.entityA1, propertyId: ids.filePropertyA1 },
        safeDb: safeDbFromScoped(nextMemberDb),
        session: { id: "fixture-session", activeOrganizationId: ids.orgA },
        user: { id: ids.userA2, email: "member@example.test" },
        workspaceId: ids.wsA1,
        memberRole: sessionMemberRole("member"),
        request: new Request("https://example.test/join"),
        route: "/v1/workspaces/:workspaceId/entities/join-folio-collab-room",
        recordAuditEvent: noAudit,
        createAuditRecorder: () => noAudit,
      }),
    );
    expect(joined).toMatchObject({
      roomId,
      generation: 6,
      shouldSeed: true,
      snapshotRecovery: "unsaved-changes-discarded",
    });
  } finally {
    fake.stop();
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, membershipId));
    if (retiredKey !== undefined) {
      await testDb
        .delete(bufferObjectCleanupIntents)
        .where(eq(bufferObjectCleanupIntents.objectKey, retiredKey));
    }
  }
});

test("deleting a pending seed claimant retires its stored snapshot under the room tenant", async () => {
  const roomId = await insertRoom({
    generation: 4,
    seedState: "claimed",
    seedClaimedAt: new Date(),
    seedClaimedBy: ids.userA1,
    yjsSnapshotRevision: 1,
    yjsSnapshotSizeBytes: 10,
    yjsSnapshotUpdatedAt: new Date(),
  });
  await testDb
    .update(folioCollabRooms)
    .set({
      savedSnapshotCut: {
        versionId: ids.entityVersionA1,
        sha256Hex: "a".repeat(64),
      },
    })
    .where(eq(folioCollabRooms.id, roomId));
  const [before] = await testDb
    .select()
    .from(folioCollabRooms)
    .where(eq(folioCollabRooms.id, roomId));
  if (!before) {
    throw new TypeError("Seed fixture room is missing");
  }
  const oldKey = createFileKey({
    fileId: before.yjsSnapshotFileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
  });
  await testDb.transaction(
    async (tx) =>
      await resetFolioCollabUserState(
        asTestRaw<Parameters<typeof resetFolioCollabUserState>[0]>(tx),
        ids.userA1,
      ),
  );
  const [after] = await testDb
    .select()
    .from(folioCollabRooms)
    .where(eq(folioCollabRooms.id, roomId));
  expect(after).toMatchObject({
    generation: 5,
    seedState: "empty",
    seededAt: null,
    savedSnapshotCut: null,
    yjsSnapshotRevision: 0,
    yjsSnapshotSizeBytes: null,
    yjsSnapshotUpdatedAt: null,
  });
  expect(after?.yjsSnapshotFileId).not.toBe(before.yjsSnapshotFileId);
  const retired = await testDb
    .select()
    .from(bufferObjectCleanupIntents)
    .where(eq(bufferObjectCleanupIntents.objectKey, oldKey));
  expect(retired).toHaveLength(1);
  expect(retired.at(0)).toMatchObject({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    status: "orphaned",
  });
  await testDb
    .delete(bufferObjectCleanupIntents)
    .where(eq(bufferObjectCleanupIntents.objectKey, oldKey));
});
