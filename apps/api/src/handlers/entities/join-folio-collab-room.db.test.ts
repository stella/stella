import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { folioCollabRooms, folioCollabRoomTokens } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cleanupExpiredFolioCollabRoomTokens } from "@/api/lib/folio-collab-rooms";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  decideFolioCollabSeedClaim,
  folioCollabSeedClaimPredicate,
} from "./join-folio-collab-room";

let testDb: TestDatabase;
let ids: TestIds;
const roomIds: SafeId<"folioCollabRoom">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
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
}: {
  generation: number;
  seedClaimedAt?: Date;
  seedClaimedBy?: SafeId<"user">;
  seedState: "claimed" | "empty" | "seeded";
  seededAt?: Date;
}) => {
  const roomId = createSafeId<"folioCollabRoom">();
  roomIds.push(roomId);
  await testDb.insert(folioCollabRooms).values({
    baseVersionId: ids.entityVersionA1,
    docxCheckpointFileId: createSafeId<"userFile">(),
    entityId: ids.entityA1,
    fileName: "contract.docx",
    generation,
    id: roomId,
    propertyId: ids.filePropertyA1,
    seedClaimedAt,
    seedClaimedBy,
    seedState,
    seededAt,
    workspaceId: ids.wsA1,
    yjsSnapshotFileId: createSafeId<"userFile">(),
  });
  return roomId;
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
  test("rejects a base version from another entity or workspace", () => {
    const roomId = createSafeId<"folioCollabRoom">();
    roomIds.push(roomId);

    expect(
      testDb
        .insert(folioCollabRooms)
        .values({
          baseVersionId: ids.entityVersionA2,
          docxCheckpointFileId: createSafeId<"userFile">(),
          entityId: ids.entityA1,
          fileName: "contract.docx",
          id: roomId,
          propertyId: ids.filePropertyA1,
          workspaceId: ids.wsA1,
          yjsSnapshotFileId: createSafeId<"userFile">(),
        })
        .execute(),
    ).rejects.toThrow('Failed query: insert into "folio_collab_rooms"');
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
    const staleAt = new Date(Date.now() - 60_000);
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
