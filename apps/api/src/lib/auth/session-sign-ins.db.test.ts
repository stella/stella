import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { SESSION_SIGN_IN_REVIEW } from "@stll/api-contract/session-sign-ins";
import { rejectionOf } from "@stll/property-testing/rejection";

import { session, user } from "@/api/db/auth-schema";
import { accountAuditLogs, sessionSignIns } from "@/api/db/schema";
import { revokeUserSessionById } from "@/api/lib/auth-artifacts";
import {
  createSessionSignInStore,
  SESSION_SIGN_IN_REVIEW_REFUSAL,
} from "@/api/lib/auth/session-sign-ins";
import type { ViewerLocation } from "@/api/lib/auth/viewer-location";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-20T12:00:00.000Z");

const BRATISLAVA = {
  type: "known",
  countryCode: "SK",
  region: "Bratislavsky kraj",
  city: "Bratislava",
  coordinates: { latitude: 48.1, longitude: 17.1 },
} as const satisfies ViewerLocation;

let testDb: TestDatabase;

// timeout: the shared PGlite database boots from its snapshot on first use
beforeAll(async () => {
  testDb = await getTestDb();
}, 120_000);

// Fixture users keep their rows: account audit history restricts deleting them.
afterAll(async () => {
  await releaseTestDb();
});

const createStore = () =>
  createSessionSignInStore({
    database:
      asTestRaw<Parameters<typeof createSessionSignInStore>[0]["database"]>(
        testDb,
      ),
    now: () => NOW,
  });

const insertUser = async () => {
  const id = mintAuthProviderIdValue();
  await testDb
    .insert(user)
    .values({ id, name: "Jana Nováková", email: `${id}@sign-in.test` });
  return brandPersistedUserId(id);
};

const insertSession = async (userId: SafeId<"user">) => {
  const id = mintAuthProviderIdValue();
  await testDb.insert(session).values({
    id,
    userId,
    token: mintAuthProviderIdValue(),
    createdAt: new Date(NOW.getTime() - DAY_MS),
    updatedAt: new Date(NOW.getTime() - DAY_MS),
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  return id;
};

const auditEvents = async (userId: SafeId<"user">) =>
  await testDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return await tx
      .select({
        type: accountAuditLogs.eventType,
        resourceId: accountAuditLogs.resourceId,
      })
      .from(accountAuditLogs)
      .where(eq(accountAuditLogs.userId, userId))
      .orderBy(accountAuditLogs.id);
  });

const request = () =>
  new Request("https://api.example.test/api/auth/session-sign-ins/review", {
    method: "POST",
  });

const pendingSignIn = async () => {
  const store = createStore();
  const userId = await insertUser();
  const sessionId = await insertSession(userId);
  await store.record({ sessionId, location: BRATISLAVA });
  await store.requestReview({ userId, sessionId });
  return { store, userId, sessionId };
};

describe("recorded sign-ins", () => {
  test("list the holder's live sessions with what the edge reported, and nothing more", async () => {
    const store = createStore();
    const owner = await insertUser();
    const other = await insertUser();
    const known = await insertSession(owner);
    const unknown = await insertSession(owner);
    const predatesRecording = await insertSession(owner);
    const othersSession = await insertSession(other);
    await store.record({ sessionId: known, location: BRATISLAVA });
    await store.record({ sessionId: unknown, location: { type: "unknown" } });
    await store.record({ sessionId: othersSession, location: BRATISLAVA });

    const listed = await store.list(owner);

    expect(listed).toHaveLength(3);
    expect(listed).toEqual(
      expect.arrayContaining([
        {
          id: known,
          location: {
            type: "known",
            countryCode: "SK",
            region: "Bratislavsky kraj",
            city: "Bratislava",
            coordinates: { latitude: 48.1, longitude: 17.1 },
          },
          review: SESSION_SIGN_IN_REVIEW.notRequired,
        },
        {
          id: unknown,
          location: { type: "unknown" },
          review: SESSION_SIGN_IN_REVIEW.notRequired,
        },
        {
          id: predatesRecording,
          location: { type: "unknown" },
          review: SESSION_SIGN_IN_REVIEW.notRequired,
        },
      ]),
    );
  });

  test("a replayed record keeps the first location", async () => {
    const store = createStore();
    const owner = await insertUser();
    const sessionId = await insertSession(owner);
    await store.record({ sessionId, location: BRATISLAVA });
    await store.record({ sessionId, location: { type: "unknown" } });

    expect((await store.list(owner)).at(0)?.location).toMatchObject({
      type: "known",
      city: "Bratislava",
    });
  });

  test("leave with their session", async () => {
    const store = createStore();
    const owner = await insertUser();
    const sessionId = await insertSession(owner);
    await store.record({ sessionId, location: BRATISLAVA });

    await revokeUserSessionById(testDb, { sessionId, userId: owner });

    expect(
      await testDb
        .select()
        .from(sessionSignIns)
        .where(eq(sessionSignIns.sessionId, sessionId)),
    ).toEqual([]);
  });

  test("an unknown location cannot carry a place", async () => {
    const owner = await insertUser();
    const sessionId = await insertSession(owner);

    const refused = await rejectionOf(
      testDb.insert(sessionSignIns).values({
        sessionId,
        locationStatus: "unknown",
        city: "Bratislava",
      }),
    );

    expect(refused).toMatchObject({
      cause: { constraint: "session_sign_ins_location_check" },
    });
  });
});

describe("sign-in review", () => {
  test("a reported sign-in waits for review once, audited once", async () => {
    const { store, userId, sessionId } = await pendingSignIn();
    await store.requestReview({ userId, sessionId });

    expect((await store.list(userId)).at(0)?.review).toBe(
      SESSION_SIGN_IN_REVIEW.pending,
    );
    expect(await auditEvents(userId)).toEqual([
      { type: "account.sign_in.review_requested", resourceId: sessionId },
    ]);
  });

  test("confirming and undoing move the status and record each change", async () => {
    const { store, userId, sessionId } = await pendingSignIn();

    const confirmed = await store.decide({
      userId,
      sessionId,
      review: SESSION_SIGN_IN_REVIEW.confirmed,
      request: request(),
    });
    // A repeated confirmation changes nothing and records nothing.
    await store.decide({
      userId,
      sessionId,
      review: SESSION_SIGN_IN_REVIEW.confirmed,
      request: request(),
    });
    const undone = await store.decide({
      userId,
      sessionId,
      review: SESSION_SIGN_IN_REVIEW.pending,
      request: request(),
    });

    expect(confirmed.unwrap()).toBe(SESSION_SIGN_IN_REVIEW.confirmed);
    expect(undone.unwrap()).toBe(SESSION_SIGN_IN_REVIEW.pending);
    expect(await auditEvents(userId)).toEqual([
      { type: "account.sign_in.review_requested", resourceId: sessionId },
      { type: "account.sign_in.confirmed", resourceId: sessionId },
      { type: "account.sign_in.confirmation_undone", resourceId: sessionId },
    ]);
  });

  test("a confirmed sign-in is not reopened by a later notice", async () => {
    const { store, userId, sessionId } = await pendingSignIn();
    await store.decide({
      userId,
      sessionId,
      review: SESSION_SIGN_IN_REVIEW.confirmed,
      request: request(),
    });

    await store.requestReview({ userId, sessionId });

    expect((await store.list(userId)).at(0)?.review).toBe(
      SESSION_SIGN_IN_REVIEW.confirmed,
    );
  });

  test("another account holder can neither decide nor request review", async () => {
    const { store, userId, sessionId } = await pendingSignIn();
    const intruder = await insertUser();

    const decided = await store.decide({
      userId: intruder,
      sessionId,
      review: SESSION_SIGN_IN_REVIEW.confirmed,
      request: request(),
    });
    const recorded = createStore();
    const otherSession = await insertSession(userId);
    await recorded.record({ sessionId: otherSession, location: BRATISLAVA });
    await recorded.requestReview({ userId: intruder, sessionId: otherSession });

    expect(decided.isErr() && decided.error).toBe(
      SESSION_SIGN_IN_REVIEW_REFUSAL.notFound,
    );
    expect(
      (await store.list(userId)).map(({ id, review }) => ({ id, review })),
    ).toEqual(
      expect.arrayContaining([
        { id: sessionId, review: SESSION_SIGN_IN_REVIEW.pending },
        { id: otherSession, review: SESSION_SIGN_IN_REVIEW.notRequired },
      ]),
    );
    expect(await auditEvents(intruder)).toEqual([]);
  });

  test("a sign-in that never asked for review cannot be decided", async () => {
    const store = createStore();
    const userId = await insertUser();
    const recorded = await insertSession(userId);
    const predatesRecording = await insertSession(userId);
    await store.record({ sessionId: recorded, location: BRATISLAVA });

    for (const sessionId of [recorded, predatesRecording]) {
      const decided = await store.decide({
        userId,
        sessionId,
        review: SESSION_SIGN_IN_REVIEW.confirmed,
        request: request(),
      });
      expect(decided.isErr() && decided.error).toBe(
        SESSION_SIGN_IN_REVIEW_REFUSAL.notUnderReview,
      );
    }
  });

  test("a signed-out session is gone, not decidable", async () => {
    const { store, userId, sessionId } = await pendingSignIn();
    await revokeUserSessionById(testDb, { sessionId, userId });

    const decided = await store.decide({
      userId,
      sessionId,
      review: SESSION_SIGN_IN_REVIEW.confirmed,
      request: request(),
    });

    expect(decided.isErr() && decided.error).toBe(
      SESSION_SIGN_IN_REVIEW_REFUSAL.notFound,
    );
  });
});

describe("sign-in map place", () => {
  test("is given only for the holder's own session with coordinates", async () => {
    const store = createStore();
    const owner = await insertUser();
    const other = await insertUser();
    const withMap = await insertSession(owner);
    const withoutCoordinates = await insertSession(owner);
    await store.record({ sessionId: withMap, location: BRATISLAVA });
    await store.record({
      sessionId: withoutCoordinates,
      location: { ...BRATISLAVA, coordinates: null },
    });

    expect(await store.mapPlace({ userId: owner, sessionId: withMap })).toEqual(
      {
        countryCode: "SK",
        point: { latitude: 48.1, longitude: 17.1 },
      },
    );
    expect(
      await store.mapPlace({ userId: other, sessionId: withMap }),
    ).toBeNull();
    expect(
      await store.mapPlace({ userId: owner, sessionId: withoutCoordinates }),
    ).toBeNull();
  });
});
