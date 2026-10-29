import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { getCookieCache } from "better-auth/cookies";
import { emailOTP } from "better-auth/plugins";
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { account, session, user, verification } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { rootDb } from "@/api/db/root";
import {
  createSessionLifetime,
  SESSION_ABSOLUTE_AGE_MS,
  SESSION_LIFETIME_FIELDS,
  SESSION_PRIOR_TOKEN_RECOVERY_MS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { hashSessionToken } from "@/api/lib/auth/session-token";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const AUTH_SECRET = "session-test-secret-that-is-long-enough-for-better-auth";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const REFRESH_EXPIRES_AT = new Date(NOW.getTime() + 30 * DAY_MS);
let testDb: TestDatabase;
let store: ReturnType<typeof createDatabaseSessionLifetimeStore>;
const fixtureUsers: string[] = [];

afterEach(() => {
  setSystemTime();
});

beforeAll(async () => {
  testDb = await getTestDb();
  store = createDatabaseSessionLifetimeStore(testDb, {
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  });
}, 120_000);

afterAll(async () => {
  if (fixtureUsers.length > 0) {
    await testDb.delete(user).where(inArray(user.id, fixtureUsers));
  }
  await releaseTestDb();
});

type FixtureOptions = {
  userId?: string;
  ageMs?: number;
  idleMs?: number | null;
  expiresAt?: Date;
  refreshMode?: (typeof session.$inferSelect)["refreshMode"];
};

const insertSession = async ({
  userId = mintAuthProviderIdValue(),
  ageMs = DAY_MS,
  idleMs = HOUR_MS,
  expiresAt = new Date(NOW.getTime() + DAY_MS),
  refreshMode = "automatic",
}: FixtureOptions = {}) => {
  fixtureUsers.push(userId);
  await testDb
    .insert(user)
    .values({
      id: userId,
      name: "Session fixture",
      email: `${userId}@session.test`,
    })
    .onConflictDoNothing({ target: user.id });
  const fixture = {
    id: mintAuthProviderIdValue(),
    userId,
    token: mintAuthProviderIdValue(),
    createdAt: new Date(NOW.getTime() - ageMs),
    updatedAt: new Date(NOW.getTime() - DAY_MS),
    lastSeenAt: idleMs === null ? null : new Date(NOW.getTime() - idleMs),
    expiresAt,
    refreshMode,
  };
  await testDb.insert(session).values(fixture);
  return fixture;
};

describe("session rollout policies", () => {
  test("legacy script sessions retain their minted expiry contract", async () => {
    const migration = await Bun.file(
      new URL(
        "../../../drizzle/20261003123100_session_lifetime/migration.sql",
        import.meta.url,
      ),
    ).text();
    const backfill =
      migration
        .split("--> statement-breakpoint")
        .find((statement) => statement.trim().startsWith('UPDATE "session"')) ??
      panic("Migration contains no session backfill");
    const cases = [
      {
        prefix: "smoke-session-",
        userAgent: "stella-smoke/deploy-verify",
        ttlMs: 15 * 60 * 1000,
        mode: "fixed",
      },
      {
        prefix: "dev-seed-session-",
        userAgent: "stella-dev-firm-knowledge-seed",
        ttlMs: 2 * HOUR_MS,
        mode: "fixed",
      },
      {
        prefix: "agent-idjag-",
        userAgent: "stella-agent-auth/id-jag",
        ttlMs: 15 * 60 * 1000,
        mode: "fixed",
      },
      {
        prefix: "smoke-session-",
        userAgent: "Session fixture",
        ttlMs: null,
        mode: "automatic",
      },
      {
        prefix: "session-fixture-",
        userAgent: "stella-smoke/deploy-verify",
        ttlMs: null,
        mode: "automatic",
      },
    ] as const;
    const fixtures = await Promise.all(
      cases.map(async (entry) => {
        const initial = await insertSession({
          userId:
            entry.prefix === "smoke-session-"
              ? "smoke-user-stella"
              : mintAuthProviderIdValue(),
        });
        const id = `${entry.prefix}${initial.id}`;
        await testDb
          .update(session)
          .set({ id, userAgent: entry.userAgent })
          .where(eq(session.id, initial.id));
        return { initial, id, entry };
      }),
    );
    await testDb.$client.exec(backfill);
    await testDb.$client.exec(backfill);
    for (const { initial, id, entry } of fixtures) {
      const current = await testDb.query.session.findFirst({
        where: { id: { eq: id } },
      });
      expect(current?.refreshMode).toBe(entry.mode);
      expect(current?.expiresAt).toEqual(
        entry.ttlMs === null
          ? initial.expiresAt
          : new Date(initial.createdAt.getTime() + entry.ttlMs),
      );
    }
    const short = await insertSession({
      userId: "smoke-user-stella",
      expiresAt: new Date(NOW.getTime() - DAY_MS + 60_000),
    });
    await testDb
      .update(session)
      .set({
        id: `smoke-session-${short.id}`,
        userAgent: "stella-smoke/deploy-verify",
      })
      .where(eq(session.id, short.id));
    await testDb.$client.exec(backfill);
    const preserved = await testDb.query.session.findFirst({
      where: { id: { eq: `smoke-session-${short.id}` } },
    });
    expect(preserved?.refreshMode).toBe("fixed");
    expect(preserved?.expiresAt).toEqual(short.expiresAt);
  });

  test("refuses a session in continuous use once it outlives the absolute lifetime", async () => {
    const outlived = await insertSession({ ageMs: 91 * DAY_MS, idleMs: 0 });
    expect(await store.observe({ token: outlived.token, now: NOW })).toBeNull();
    const within = await insertSession({ ageMs: 89 * DAY_MS, idleMs: 0 });
    expect(
      await store.observe({ token: within.token, now: NOW }),
    ).not.toBeNull();
  });

  test("never refreshes a session past its absolute lifetime", async () => {
    const fixture = await insertSession({ ageMs: 80 * DAY_MS });
    const refreshed = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(refreshed?.expiresAt).toEqual(
      new Date(fixture.createdAt.getTime() + SESSION_ABSOLUTE_AGE_MS),
    );
  });

  test("rotates every refreshed session and honours the prior token until its recovery ceiling", async () => {
    const fixture = await insertSession();
    const refreshed = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(refreshed).not.toBeNull();
    expect(refreshed?.token).not.toBe(fixture.token);
    expect(refreshed?.expiresAt).toEqual(REFRESH_EXPIRES_AT);
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + SESSION_PRIOR_TOKEN_RECOVERY_MS - 1),
      }),
    ).not.toBeNull();
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + SESSION_PRIOR_TOKEN_RECOVERY_MS + 1),
      }),
    ).toBeNull();
  });

  test("refreshes a capped session once per update interval", async () => {
    const fixture = await insertSession({ ageMs: 80 * DAY_MS });
    const first = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    const rotated = first?.token ?? panic("First refresh did not rotate");
    expect(rotated).not.toBe(fixture.token);
    const second = await store.refresh({
      token: rotated,
      now: new Date(NOW.getTime() + 1000),
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(second?.token).toBe(rotated);
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + 30_000),
      }),
    ).not.toBeNull();
  });

  test("extends a throttled session without rotating past its absolute lifetime", async () => {
    const fixture = await insertSession({
      ageMs: 80 * DAY_MS,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await testDb
      .update(session)
      .set({ updatedAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(session.id, fixture.id));

    const refreshed = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });

    expect(refreshed?.token).toBe(fixture.token);
    expect(refreshed?.expiresAt).toEqual(
      new Date(fixture.createdAt.getTime() + SESSION_ABSOLUTE_AGE_MS),
    );
  });

  test("preserves fixed sessions and their expiry", async () => {
    const fixture = await insertSession({
      refreshMode: "fixed",
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    const refreshed = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(refreshed?.token).toBe(fixture.token);
    expect(refreshed?.expiresAt).toEqual(fixture.expiresAt);
    expect(
      (
        await testDb.query.session.findFirst({
          where: { id: { eq: fixture.id } },
        })
      )?.priorTokenHash,
    ).toBeNull();
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + 60_001),
      }),
    ).not.toBeNull();
    expect(
      await store.observe({ token: fixture.token, now: fixture.expiresAt }),
    ).toBeNull();
  });

  test("tracks activity at five-minute intervals", async () => {
    const fixture = await insertSession({ idleMs: 0 });
    for (const elapsedMs of [0, 1, 60_000, 299_999]) {
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + elapsedMs),
      });
      const persisted = await testDb.query.session.findFirst({
        where: { id: { eq: fixture.id } },
      });
      expect(persisted?.lastSeenAt).toEqual(NOW);
    }
    await store.observe({
      token: fixture.token,
      now: new Date(NOW.getTime() + 300_000),
    });
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.lastSeenAt).toEqual(new Date(NOW.getTime() + 300_000));
  });
});

describe("session refresh credentials", () => {
  test("serialized refresh requests converge without changing the session identity or age", async () => {
    const fixture = await insertSession();
    const refreshed = await Promise.all(
      Array.from(
        { length: 8 },
        async () =>
          await store.refresh({
            token: fixture.token,
            now: NOW,
            expiresAt: REFRESH_EXPIRES_AT,
          }),
      ),
    );
    const current = refreshed.at(0);
    expect(current).not.toBeNull();
    expect(current?.token).not.toBe(fixture.token);
    expect(new Set(refreshed.map((row) => row?.token)).size).toBe(1);
    for (const row of refreshed) {
      expect(row?.id).toBe(fixture.id);
      expect(row?.createdAt).toEqual(fixture.createdAt);
      expect(row?.expiresAt).toEqual(REFRESH_EXPIRES_AT);
    }
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.token).toBe(current?.token);
    expect(persisted?.priorTokenHash).toBe(hashSessionToken(fixture.token));
    expect(persisted?.priorTokenHash).not.toBe(fixture.token);
    expect(persisted?.priorTokenExpiresAt).toEqual(
      new Date(NOW.getTime() + SESSION_PRIOR_TOKEN_RECOVERY_MS),
    );
  });

  test("the unconfirmed prior credential works only before the recovery ceiling", async () => {
    const fixture = await insertSession();
    const current = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(current).not.toBeNull();
    const grace = await store.observe({
      token: fixture.token,
      now: new Date(NOW.getTime() + SESSION_PRIOR_TOKEN_RECOVERY_MS - 1),
    });
    expect(grace?.token).toBe(current?.token);
    for (const elapsedMs of [
      SESSION_PRIOR_TOKEN_RECOVERY_MS,
      SESSION_PRIOR_TOKEN_RECOVERY_MS + 1,
    ]) {
      expect(
        await store.observe({
          token: fixture.token,
          now: new Date(NOW.getTime() + elapsedMs),
        }),
      ).toBeNull();
    }
    expect(
      await store.observe({
        token: current?.token ?? "missing-credential",
        now: new Date(NOW.getTime() + SESSION_PRIOR_TOKEN_RECOVERY_MS + 1),
      }),
    ).not.toBeNull();
  });

  test("revocation removes the current credential and its in-flight alias", async () => {
    const fixture = await insertSession();
    const current = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(current).not.toBeNull();
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: AUTH_SECRET,
      database: drizzleAdapter(asTestRaw<typeof rootDb>(testDb), {
        provider: "pg",
        schema: { account, session, user, verification },
      }),
    });
    const context = await auth.$context;
    await context.internalAdapter.deleteSession(
      current?.token ?? panic("Refresh did not retain the fixture session"),
    );
    for (const token of [
      fixture.token,
      current?.token ?? "missing-credential",
    ]) {
      expect(await store.observe({ token, now: NOW })).toBeNull();
      expect(
        await store.refresh({
          token,
          now: NOW,
          expiresAt: REFRESH_EXPIRES_AT,
        }),
      ).toBeNull();
    }
  });

  test("an unexpired session outside its refresh window keeps its credential", async () => {
    const fixture = await insertSession({ expiresAt: REFRESH_EXPIRES_AT });
    const current = await store.refresh({
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(current?.token).toBe(fixture.token);
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.priorTokenHash).toBeNull();
  });
});

describe("absolute session age", () => {
  const observationCases = [90 * DAY_MS - 1, 90 * DAY_MS, 91 * DAY_MS].flatMap(
    (ageMs) => [0, HOUR_MS, null].map((idleMs) => ({ ageMs, idleMs })),
  );
  test.each(observationCases)(
    "%j is refused exactly from the absolute age, whatever the activity",
    async ({ ageMs, idleMs }) => {
      const fixture = await insertSession({ ageMs, idleMs });
      const observed = await store.observe({ token: fixture.token, now: NOW });
      expect(observed === null).toBe(ageMs >= SESSION_ABSOLUTE_AGE_MS);
      const persisted = await testDb.query.session.findFirst({
        where: { id: { eq: fixture.id } },
      });
      expect(persisted?.createdAt).toEqual(fixture.createdAt);
    },
  );

  test("an outlived session cannot be refreshed back to life", async () => {
    const fixture = await insertSession({ ageMs: 91 * DAY_MS, idleMs: 0 });
    expect(
      await store.refresh({
        token: fixture.token,
        now: NOW,
        expiresAt: REFRESH_EXPIRES_AT,
      }),
    ).toBeNull();
  });

  test("out-of-order observations keep the latest activity clock", async () => {
    const fixture = await insertSession({ ageMs: DAY_MS });
    const recent = new Date(NOW.getTime() + HOUR_MS);
    await store.observe({ token: fixture.token, now: recent });
    await store.observe({ token: fixture.token, now: NOW });
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.lastSeenAt).toEqual(recent);
  });
});

const responseCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(
      (value) =>
        value.split(";").at(0) ??
        panic("Response cookie has no name and value"),
    )
    .join("; ");

const createHttpSession = async (cacheEnabled: boolean) => {
  let clock = new Date();
  setSystemTime(clock);
  let authoritativeToken: string | null | undefined;
  let resolvedSessionToken: string | null | undefined;
  const fixtureDb = drizzle({
    client: testDb.$client,
    relations: databaseRelations,
    logger: queryCountLogger,
  });
  const fixtureStore = createDatabaseSessionLifetimeStore(fixtureDb, {
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  });
  const lifetime = createSessionLifetime({
    store: fixtureStore,
    now: () => clock,
  });
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: AUTH_SECRET,
    database: drizzleAdapter(asTestRaw<typeof rootDb>(fixtureDb), {
      provider: "pg",
      schema: { account, session, user, verification },
    }),
    session: {
      additionalFields: SESSION_LIFETIME_FIELDS,
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: {
        enabled: cacheEnabled,
        maxAge: 60,
        version: lifetime.cookieCacheVersion,
      },
    },
    plugins: [
      emailOTP({
        generateOTP: () => "123456",
        sendVerificationOTP: async () => undefined,
      }),
      lifetime.plugin,
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/get-session") {
          resolvedSessionToken = ctx.context.session?.session.token ?? null;
        }
        await Promise.resolve();
      }),
      before: createAuthMiddleware(async (ctx) => {
        lifetime.prepare(ctx.context);
        if (ctx.headers?.get("x-stella-test-authoritative") === "1") {
          const resolved = await getAuthoritativeSessionFromCtx(ctx);
          authoritativeToken = resolved?.session.token ?? null;
        }
      }),
    },
  });
  const email = `${mintAuthProviderIdValue()}@http-session.test`.toLowerCase();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const signIn = await auth.handler(
    new Request("http://localhost:3001/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify({
        email,
        name: "Session fixture",
        otp: "123456",
      }),
    }),
  );
  expect(signIn.status).toBe(200);
  const accountUser = await testDb.query.user.findFirst({
    where: { email: { eq: email } },
  });
  const userId =
    accountUser?.id ?? panic("Sign-in did not create the fixture user");
  fixtureUsers.push(userId);
  const created = await testDb.query.session.findFirst({
    where: { userId: { eq: userId } },
  });
  const original =
    created ?? panic("Sign-in did not create the fixture session");
  const cookie = responseCookies(signIn);
  expect(cookie).toContain("session_token=");
  if (cacheEnabled) {
    expect(cookie).toContain("session_data=");
  }
  const requestSession = async ({
    requestCookie = cookie,
    disableCookieCache = false,
    authoritative = false,
  } = {}) =>
    await auth.handler(
      new Request(
        `http://localhost:3001/api/auth/get-session${disableCookieCache ? "?disableCookieCache=true" : ""}`,
        {
          headers: {
            cookie: requestCookie,
            ...(authoritative ? { "x-stella-test-authoritative": "1" } : {}),
          },
        },
      ),
    );
  return {
    original,
    clock,
    cookie,
    requestSession,
    authoritativeToken: () => authoritativeToken,
    resolvedSessionToken: () => resolvedSessionToken,
    advance: (elapsedMs: number) => {
      clock = new Date(clock.getTime() + elapsedMs);
      setSystemTime(clock);
    },
  };
};

describe("native authentication session responses", () => {
  test.each(["cap", "revocation"] as const)(
    "cookie cache bounds stale %s snapshots to its window",
    async (transition) => {
      const fixture = await createHttpSession(true);
      let requestCookie = fixture.cookie;
      const createdAt = new Date(
        fixture.clock.getTime() - SESSION_ABSOLUTE_AGE_MS + 30_000,
      );
      if (transition === "cap") {
        await testDb
          .update(session)
          .set({ createdAt })
          .where(eq(session.id, fixture.original.id));
        const snapshot = await fixture.requestSession({
          disableCookieCache: true,
        });
        expect(await snapshot.json()).toMatchObject({
          session: { id: fixture.original.id },
        });
        const tokenCookie =
          fixture.cookie
            .split("; ")
            .find((cookie) =>
              cookie.startsWith("better-auth.session_token="),
            ) ?? panic("Sign-in has no token cookie");
        requestCookie = `${tokenCookie}; ${responseCookies(snapshot)}`;
      } else {
        await store.revokeById({
          sessionId: fixture.original.id,
          userId: brandPersistedUserId(fixture.original.userId),
        });
      }
      fixture.advance(59_000);
      await runWithQueryCounter(async (counter) => {
        const cached = await fixture.requestSession({ requestCookie });
        expect(await cached.json()).toMatchObject({
          session: {
            id: fixture.original.id,
            createdAt: (transition === "cap"
              ? createdAt
              : fixture.original.createdAt
            ).toISOString(),
          },
        });
        expect(counter.count).toBe(0);
      });
      fixture.advance(1001);
      const expiredCache = await fixture.requestSession({ requestCookie });
      expect(await expiredCache.json()).toBeNull();
    },
  );

  test("a session already capped skips the native refresh write", async () => {
    const fixture = await createHttpSession(false);
    await testDb
      .update(session)
      .set({
        createdAt: new Date(fixture.clock.getTime() - 89 * DAY_MS),
        updatedAt: new Date(fixture.clock.getTime() - 2 * DAY_MS),
        lastSeenAt: fixture.clock,
        expiresAt: new Date(fixture.clock.getTime() + DAY_MS),
      })
      .where(eq(session.id, fixture.original.id));
    await runWithQueryCounter(async (counter) => {
      const response = await fixture.requestSession();
      expect(await response.json()).toMatchObject({
        session: { token: fixture.original.token },
      });
      expect(counter.count).toBe(2);
    });
  });

  test.each([false, true])(
    "removes an expired current session through native resolution with cookie cache %s",
    async (cacheEnabled) => {
      const fixture = await createHttpSession(cacheEnabled);
      await testDb
        .update(session)
        .set({
          expiresAt: new Date(fixture.clock.getTime() - 1),
        })
        .where(eq(session.id, fixture.original.id));
      const response = await fixture.requestSession({
        disableCookieCache: true,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      expect(
        await testDb.query.session.findFirst({
          where: { id: { eq: fixture.original.id } },
        }),
      ).toBeUndefined();
    },
  );

  test("cached and recent session reads avoid activity writes", async () => {
    const fixture = await createHttpSession(true);
    await testDb
      .update(session)
      .set({ lastSeenAt: fixture.clock })
      .where(eq(session.id, fixture.original.id));
    const requestCount = async (disableCookieCache: boolean) =>
      await runWithQueryCounter(async (counter) => {
        const response = await fixture.requestSession({ disableCookieCache });
        expect(response.status).toBe(200);
        expect(await response.json()).not.toBeNull();
        return counter.count;
      });
    expect(await requestCount(false)).toBe(0);
    // An uncached read observes the session row once and reuses it, reading
    // only its user: two statements. Past the activity interval it adds the
    // one activity write.
    expect(await requestCount(true)).toBe(2);
    fixture.advance(5 * 60 * 1000);
    expect(await requestCount(true)).toBe(3);
    expect(await requestCount(true)).toBe(2);
  });
  test("global before-hook authoritative resolution observes the absolute lifetime before plugin hooks", async () => {
    const fixture = await createHttpSession(true);
    await testDb
      .update(session)
      .set({
        createdAt: new Date(fixture.clock.getTime() - 91 * DAY_MS),
        lastSeenAt: new Date(fixture.clock.getTime() - HOUR_MS),
      })
      .where(eq(session.id, fixture.original.id));
    const response = await fixture.requestSession({
      authoritative: true,
      disableCookieCache: true,
    });
    expect(fixture.authoritativeToken()).toBeNull();
    expect(await response.json()).toBeNull();
  });
  test.each([false, true])(
    "an outlived session is refused with cookie cache %s",
    async (cacheEnabled) => {
      const fixture = await createHttpSession(cacheEnabled);
      await testDb
        .update(session)
        .set({
          createdAt: new Date(fixture.clock.getTime() - 91 * DAY_MS),
          lastSeenAt: new Date(fixture.clock.getTime() - HOUR_MS),
        })
        .where(eq(session.id, fixture.original.id));
      const response = await fixture.requestSession({
        disableCookieCache: true,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      expect(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.includes("Max-Age=0")),
      ).toBe(true);
      expect(
        await testDb.query.session.findFirst({
          where: { id: { eq: fixture.original.id } },
        }),
      ).toBeUndefined();
    },
  );

  test.each([false, true])(
    "continuous activity does not keep an outlived session with cookie cache %s",
    async (cacheEnabled) => {
      const fixture = await createHttpSession(cacheEnabled);
      await testDb
        .update(session)
        .set({
          createdAt: new Date(fixture.clock.getTime() - 91 * DAY_MS),
          lastSeenAt: fixture.clock,
        })
        .where(eq(session.id, fixture.original.id));
      const response = await fixture.requestSession({
        disableCookieCache: true,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    },
  );
  test("the replacement cookie confirms rotation on its first cached read", async () => {
    const fixture = await createHttpSession(true);
    await testDb
      .update(session)
      .set({
        updatedAt: new Date(fixture.clock.getTime() - 2 * DAY_MS),
        expiresAt: new Date(fixture.clock.getTime() + DAY_MS),
      })
      .where(eq(session.id, fixture.original.id));
    const rotated = await fixture.requestSession({ disableCookieCache: true });
    const newCookie = responseCookies(rotated);
    expect(newCookie).toContain("session_data=");
    expect(
      await (await fixture.requestSession({ requestCookie: newCookie })).json(),
    ).toMatchObject({ session: { id: fixture.original.id } });
    // A request still in flight with the old cookie keeps working briefly.
    expect(
      await (await fixture.requestSession({ disableCookieCache: true })).json(),
    ).toMatchObject({ session: { id: fixture.original.id } });
    fixture.advance(60_001);
    expect(
      await (await fixture.requestSession({ disableCookieCache: true })).json(),
    ).toBeNull();
  });

  test("native refresh recovers a dropped cookie until the replacement is presented", async () => {
    const fixture = await createHttpSession(true);
    const createdAt = new Date(fixture.clock.getTime() - 85 * DAY_MS);
    await testDb
      .update(session)
      .set({
        createdAt,
        updatedAt: new Date(fixture.clock.getTime() - 2 * DAY_MS),
        expiresAt: new Date(fixture.clock.getTime() + DAY_MS),
      })
      .where(eq(session.id, fixture.original.id));
    const refreshed = await fixture.requestSession({
      disableCookieCache: true,
    });
    expect(refreshed.status).toBe(200);
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.original.id } },
    });
    const current = persisted ?? panic("Refresh removed the fixture session");
    expect(current.token).not.toBe(fixture.original.token);
    expect(fixture.resolvedSessionToken()).toBe(current.token);
    expect(current.createdAt).toEqual(createdAt);
    const body = await refreshed.json();
    expect(body).toMatchObject({
      session: { id: fixture.original.id, token: current.token },
    });
    for (const [field, config] of Object.entries(SESSION_LIFETIME_FIELDS)) {
      if ("returned" in config) {
        expect(body).not.toHaveProperty(`session.${field}`);
      }
    }
    const refreshedCookie = responseCookies(refreshed);
    expect(refreshedCookie).toContain("session_token=");
    expect(refreshedCookie).not.toBe(fixture.cookie);
    const cached = await getCookieCache(
      new Headers({ cookie: refreshedCookie }),
      {
        secret: AUTH_SECRET,
        isSecure: false,
      },
    );
    expect(cached).not.toBeNull();
    expect(cached).toMatchObject({ session: { token: current.token } });
    for (const [field, config] of Object.entries(SESSION_LIFETIME_FIELDS)) {
      if ("returned" in config) {
        expect(cached).not.toHaveProperty(`session.${field}`);
      }
    }
    fixture.advance(59_999);
    const cachedInFlight = await fixture.requestSession();
    expect(await cachedInFlight.json()).toMatchObject({
      session: { token: fixture.original.token },
    });
    const inFlight = await fixture.requestSession({ disableCookieCache: true });
    expect(await inFlight.json()).toMatchObject({
      session: { token: current.token },
    });
    expect(responseCookies(inFlight)).toContain("session_token=");
    fixture.advance(60_001);
    const retryAfterDroppedResponse = await fixture.requestSession({
      disableCookieCache: true,
    });
    expect(await retryAfterDroppedResponse.json()).toMatchObject({
      session: { token: current.token },
    });
    fixture.advance(60_000);
    expect(
      await (await fixture.requestSession({ disableCookieCache: true })).json(),
    ).toMatchObject({ session: { token: current.token } });
    const confirmed = await fixture.requestSession({
      requestCookie: refreshedCookie,
      disableCookieCache: true,
    });
    expect(await confirmed.json()).toMatchObject({
      session: { token: current.token },
    });
    // Old-cookie requests already in flight survive the confirmation briefly.
    const inFlightAfterConfirm = await fixture.requestSession({
      disableCookieCache: true,
    });
    expect(await inFlightAfterConfirm.json()).toMatchObject({
      session: { token: current.token },
    });
    fixture.advance(60_001);
    const stale = await fixture.requestSession({ disableCookieCache: true });
    expect(await stale.json()).toBeNull();
    fixture.advance(1);
    const staleCached = await fixture.requestSession();
    expect(await staleCached.json()).toBeNull();
    const active = await fixture.requestSession({
      requestCookie: refreshedCookie,
    });
    expect(await active.json()).toMatchObject({
      session: { id: fixture.original.id, token: current.token },
    });
  });
});
