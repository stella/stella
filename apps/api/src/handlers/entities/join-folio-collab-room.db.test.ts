import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { Doc, XmlElement, XmlText, encodeStateAsUpdate } from "yjs";

import { sha256Hex as legacyHex } from "@stll/sha256/node";

import { folioCollabRooms, folioCollabRoomTokens } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { FOLIO_COLLAB_SEED_CLAIM_STALE_MS } from "@/api/lib/folio-collab-room-contract";
import {
  cleanupExpiredFolioCollabRoomTokens,
  folioCollabSeedClaimLeaseOnHeartbeat,
  issueFolioCollabToken,
  loadFolioCollabSnapshot,
} from "@/api/lib/folio-collab-rooms";
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

import {
  decideFolioCollabSeedClaim,
  decideFolioCollabSnapshotRecovery,
  folioCollabSeedClaimPredicate,
} from "./join-folio-collab-room";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: Awaited<ReturnType<typeof getRlsFixture>>["scopedQuery"];
const roomIds: SafeId<"folioCollabRoom">[] = [];
const UNSUPPORTED_FOLIO_ATTR_SCHEMA_VERSION = 11;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
});

afterEach(async () => {
  if (roomIds.length === 0) {
    return;
  }
  await testDb
    .delete(folioCollabRooms)
    .where(inArray(folioCollabRooms.id, roomIds));
  roomIds.length = 0;
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

const unsupportedSnapshot = () => {
  const doc = new Doc();
  doc
    .getMap("folio:document-metadata")
    .set("attrSchemaVersion", UNSUPPORTED_FOLIO_ATTR_SCHEMA_VERSION);
  const paragraph = new XmlElement("paragraph");
  const text = new XmlText();
  text.insert(0, "1", { footnoteRef: { id: 1 } });
  paragraph.insert(0, [text]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  const update = encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

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

  test("refused seeded snapshots reset persisted state once", async () => {
    const snapshotBytes = unsupportedSnapshot();
    const roomId = await insertRoom({
      generation: 4,
      seedClaimedBy: ids.userA1,
      seedState: "seeded",
      yjsSnapshotRevision: 7,
      yjsSnapshotSizeBytes: snapshotBytes.byteLength,
    });
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
      snapshotRevision: 7,
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
      (await loadFolioCollabSnapshot(loadTarget, readObject)).unwrap(),
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
    expect(reset?.snapshotRecoveredAt).toBeInstanceOf(Date);
    // The reset revision is 0, so only the recovery marker can tell the
    // client that seeds the room next that unsaved changes were discarded.
    expect(
      decideFolioCollabSnapshotRecovery({
        shouldSeed: true,
        snapshotRecovered: reset?.snapshotRecoveredAt instanceof Date,
        yjsSnapshotRevision: reset?.snapshotRevision ?? -1,
      }),
    ).toBe("unsaved-changes-discarded");
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
    expect(readCount).toBe(1);

    expect(
      (await loadFolioCollabSnapshot(loadTarget, readObject)).unwrap(),
    ).toEqual({
      generation: 5,
      loadOutcome: "loaded",
      snapshotBase64: null,
      snapshotRevision: 0,
    });
    expect(readCount).toBe(1);
  });
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
      generation: 0,
      permissions: { canEdit: true },
      roomId,
      tx,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    }),
  );
  const stored = await testDb
    .select({ tokenHash: folioCollabRoomTokens.tokenHash })
    .from(folioCollabRoomTokens)
    .where(eq(folioCollabRoomTokens.roomId, roomId));
  expect(stored).toEqual([{ tokenHash: legacyHex(token) }]);
});
