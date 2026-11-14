import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { session, user } from "@/api/db/auth-schema";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { readLiveSseSessions } from "@/api/lib/auth/sse-session-liveness";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-21T12:00:00.000Z");

let testDb: TestDatabase;
const fixtureUsers: string[] = [];

beforeAll(async () => {
  testDb = await getTestDb();
}, 120_000);

afterAll(async () => {
  if (fixtureUsers.length > 0) {
    await testDb.delete(user).where(inArray(user.id, fixtureUsers));
  }
  await releaseTestDb();
});

const insertUser = async () => {
  const id = mintAuthProviderIdValue();
  fixtureUsers.push(id);
  await testDb
    .insert(user)
    .values({ id, name: "Stream fixture", email: `${id}@stream.test` });
  return brandPersistedUserId(id);
};

const insertSession = async (
  userId: string,
  expiresAt = new Date(NOW.getTime() + DAY_MS),
) => {
  const row = {
    id: mintAuthProviderIdValue(),
    userId,
    token: mintAuthProviderIdValue(),
    createdAt: new Date(NOW.getTime() - DAY_MS),
    updatedAt: new Date(NOW.getTime() - DAY_MS),
    expiresAt,
  };
  await testDb.insert(session).values(row);
  return row.id;
};

describe("the sessions an open event stream may still serve", () => {
  test("hold only while the row exists, belongs to the stream's user and has not expired", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const live = await insertSession(owner);
    const expired = await insertSession(
      owner,
      new Date(NOW.getTime() - 60_000),
    );
    const revoked = await insertSession(owner);
    const othersSession = await insertSession(other);
    await createDatabaseSessionLifetimeStore(testDb, {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    }).revokeById({ sessionId: revoked, userId: owner });

    const held = await readLiveSseSessions(
      testDb,
      [
        { sessionId: live, userId: owner },
        { sessionId: expired, userId: owner },
        { sessionId: revoked, userId: owner },
        // A stream bound to the owner never rides on someone else's session.
        { sessionId: othersSession, userId: owner },
        { sessionId: mintAuthProviderIdValue(), userId: owner },
      ],
      NOW,
    );

    expect([...held]).toEqual([live]);
  });

  test("reads nothing for no streams", async () => {
    expect(await readLiveSseSessions(testDb, [], NOW)).toEqual(new Set());
  });
});
