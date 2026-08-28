import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { desktopEditSessions, entities } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { queryEntities } from "./query-entities";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const sessionIds: SafeId<"desktopEditSession">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
});

afterAll(async () => {
  try {
    await clearSessions();
  } finally {
    await releaseRlsFixture();
  }
});

const clearSessions = async (): Promise<void> => {
  if (sessionIds.length === 0) {
    return;
  }
  await testDb
    .delete(desktopEditSessions)
    .where(inArray(desktopEditSessions.id, sessionIds));
  sessionIds.length = 0;
};

afterEach(async () => {
  await clearSessions();
});

beforeEach(async () => {
  await clearSessions();
});

const insertLiveSession = async ({
  createdAt,
  createdBy,
  status = "open",
  id,
  propertyId,
  tokenExpiresAt = new Date("2100-01-01T00:00:00.000Z"),
}: {
  createdAt: Date;
  createdBy: SafeId<"user">;
  id: SafeId<"desktopEditSession">;
  propertyId: SafeId<"property">;
  status?: "cancelled" | "open";
  tokenExpiresAt?: Date;
}): Promise<void> => {
  sessionIds.push(id);
  await testDb.insert(desktopEditSessions).values({
    id,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    propertyId,
    baseVersionId: ids.entityVersionA1,
    createdBy,
    fileName: "active.docx",
    fileType: "docx",
    checkpointFileId: toSafeId<"userFile">(Bun.randomUUIDv7()),
    sessionTokenHash: Bun.randomUUIDv7().replaceAll("-", ""),
    tokenExpiresAt,
    createdAt,
    status,
  });
};

const readActiveEditor = async () => {
  const result = await queryEntities({
    safeDb,
    workspaceId: ids.wsA1,
    currentUserId: ids.userA1,
    currentOrganizationId: ids.orgA,
    filters: [],
    sorts: [],
    limit: 10,
    fieldMode: "visible",
    fieldIds: [],
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value.entities.find(
    (entity) => entity.entityId === ids.entityA1,
  )?.activeEditBy;
};

describe("entity active edit indicators", () => {
  test("shows the oldest live session when an entity has concurrent editors", async () => {
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1,
      createdBy: ids.userA1,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1dep,
      createdBy: ids.userA2,
      createdAt: new Date("2026-08-01T11:00:00.000Z"),
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toEqual({
      name: "User A1",
      image: null,
      isMe: true,
    });
  });

  test("breaks equal creation timestamps by session id", async () => {
    const firstId = toSafeId<"desktopEditSession">(Bun.randomUUIDv7());
    const secondId = toSafeId<"desktopEditSession">(Bun.randomUUIDv7());
    const expectedEditor = firstId < secondId ? ids.userA1 : ids.userA2;
    const createdAt = new Date("2026-08-01T12:00:00.000Z");

    await insertLiveSession({
      id: firstId,
      propertyId: ids.propertyA1,
      createdBy: ids.userA1,
      createdAt,
    });
    await insertLiveSession({
      id: secondId,
      propertyId: ids.propertyA1dep,
      createdBy: ids.userA2,
      createdAt,
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toMatchObject({
      name: expectedEditor === ids.userA1 ? "User A1" : "User A2",
      isMe: expectedEditor === ids.userA1,
    });
  });

  test("excludes expired and closed sessions", async () => {
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1,
      createdBy: ids.userA1,
      createdAt: new Date("2026-08-01T09:00:00.000Z"),
      tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1dep,
      createdBy: ids.userA2,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      status: "cancelled",
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toBeNull();
  });

  test("does not expose an editor outside the active organization", async () => {
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1,
      createdBy: ids.userB1,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toBeNull();
  });
});

describe("entity creator projection", () => {
  test("keeps the creator ID when the entity has a different last editor", async () => {
    await testDb
      .update(entities)
      .set({ createdBy: ids.userA1, lastEditedBy: ids.userA2 })
      .where(eq(entities.id, ids.entityA1));

    try {
      const result = await queryEntities({
        safeDb,
        workspaceId: ids.wsA1,
        currentUserId: ids.userA1,
        currentOrganizationId: ids.orgA,
        filters: [],
        sorts: [],
        limit: 10,
        fieldMode: "visible",
        fieldIds: [],
      });
      if (Result.isError(result)) {
        throw result.error;
      }

      const entity = result.value.entities.find(
        (candidate) => candidate.entityId === ids.entityA1,
      );
      expect(entity?.createdBy).toBe("User A1");
      expect(entity?.createdByUserId).toBe(ids.userA1);
    } finally {
      await testDb
        .update(entities)
        .set({ createdBy: null, lastEditedBy: null })
        .where(eq(entities.id, ids.entityA1));
    }
  });
});
