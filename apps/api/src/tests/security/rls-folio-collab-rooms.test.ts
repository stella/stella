import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { folioCollabRooms, folioCollabRoomTokens } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  createScopedQuery,
  TestDatabase,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;

const roomA = createSafeId<"folioCollabRoom">();
const roomB = createSafeId<"folioCollabRoom">();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;

  await testDb.insert(folioCollabRooms).values([
    {
      baseVersionId: ids.entityVersionA1,
      docxCheckpointFileId: createSafeId<"userFile">(),
      entityId: ids.entityA1,
      fileName: "workspace-a.docx",
      id: roomA,
      propertyId: ids.filePropertyA1,
      workspaceId: ids.wsA1,
      yjsSnapshotFileId: createSafeId<"userFile">(),
    },
    {
      baseVersionId: ids.entityVersionB1,
      docxCheckpointFileId: createSafeId<"userFile">(),
      entityId: ids.entityB1,
      fileName: "workspace-b.docx",
      id: roomB,
      propertyId: ids.filePropertyB1,
      workspaceId: ids.wsB1,
      yjsSnapshotFileId: createSafeId<"userFile">(),
    },
  ]);
  await testDb.insert(folioCollabRoomTokens).values([
    {
      expiresAt: new Date(Date.now() + 60_000),
      generation: 0,
      id: createSafeId<"folioCollabRoomToken">(),
      permissions: { canEdit: true },
      roomId: roomA,
      tokenHash: "a".repeat(64),
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    },
    {
      expiresAt: new Date(Date.now() + 60_000),
      generation: 0,
      id: createSafeId<"folioCollabRoomToken">(),
      permissions: { canEdit: true },
      roomId: roomB,
      tokenHash: "b".repeat(64),
      userId: ids.userB1,
      workspaceId: ids.wsB1,
    },
  ]);
});

afterAll(async () => {
  await testDb
    .delete(folioCollabRooms)
    .where(inArray(folioCollabRooms.id, [roomA, roomB]));
  await releaseRlsFixture();
});

describe("folio collaboration room RLS", () => {
  test("a workspace scope sees only its room and credentials", async () => {
    const result = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => ({
        rooms: await tx
          .select({ id: folioCollabRooms.id })
          .from(folioCollabRooms),
        tokens: await tx
          .select({ roomId: folioCollabRoomTokens.roomId })
          .from(folioCollabRoomTokens),
      }),
      ids.userA1,
    );

    expect(result).toEqual({
      rooms: [{ id: roomA }],
      tokens: [{ roomId: roomA }],
    });
  });

  test("a workspace scope cannot mutate another workspace's room", async () => {
    const updated = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tx
          .update(folioCollabRooms)
          .set({ lastActivityAt: new Date() })
          .where(eq(folioCollabRooms.id, roomB))
          .returning({ id: folioCollabRooms.id }),
      ids.userA1,
    );

    expect(updated).toEqual([]);
  });
});
