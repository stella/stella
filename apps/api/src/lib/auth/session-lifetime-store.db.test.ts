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

import { AUTH_SESSION_STARTUP_HEADER } from "@stll/auth-model";

import { account, session, user, verification } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { rootDb } from "@/api/db/root";
import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { hashSessionToken } from "@/api/lib/auth/session-token";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
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
    rotationEnabled: true,
    capEnabled: true,
  });
}, 120_000);

afterAll(async () => {
  if (fixtureUsers.length > 0) {
    await testDb.delete(user).where(inArray(user.id, fixtureUsers));
  }
  await releaseTestDb();
});

type FixtureOptions = {
  ageMs?: number;
  idleMs?: number | null;
  expiresAt?: Date;
  refreshMode?: (typeof session.$inferSelect)["refreshMode"];
};

const insertSession = async ({
  ageMs = DAY_MS,
  idleMs = HOUR_MS,
  expiresAt = new Date(NOW.getTime() + DAY_MS),
  refreshMode = "automatic",
}: FixtureOptions = {}) => {
  const userId = mintAuthProviderIdValue();
  fixtureUsers.push(userId);
  await testDb.insert(user).values({
    id: userId,
    name: "Session fixture",
    email: `${userId}@session.test`,
  });
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
        const initial = await insertSession();
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
      where: { userId: { eq: short.userId } },
    });
    expect(preserved?.refreshMode).toBe("fixed");
    expect(preserved?.expiresAt).toEqual(short.expiresAt);
  });

  test("keeps both rollout policies disabled by default", async () => {
    const defaults = createDatabaseSessionLifetimeStore(testDb, {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    });
    const fixture = await insertSession({ ageMs: 91 * DAY_MS });
    expect(
      await defaults.observe({
        token: fixture.token,
        now: NOW,
        boundary: "startup",
      }),
    ).not.toBeNull();
    const refreshed = await defaults.refresh({
      credentialMode: "cookie",
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(refreshed?.token).toBe(fixture.token);
    expect(refreshed?.expiresAt).toEqual(REFRESH_EXPIRES_AT);
    expect(
      (
        await testDb.query.session.findFirst({
          where: { id: { eq: fixture.id } },
        })
      )?.priorTokenHash,
    ).toBeNull();
  });

  test("configures rotation and startup expiration independently", async () => {
    for (const rotationEnabled of [false, true]) {
      for (const capEnabled of [false, true]) {
        const configured = createDatabaseSessionLifetimeStore(testDb, {
          expiresIn: 30 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
          rotationEnabled,
          capEnabled,
        });
        const old = await insertSession({ ageMs: 91 * DAY_MS });
        expect(
          (await configured.observe({
            token: old.token,
            now: NOW,
            boundary: "startup",
          })) === null,
        ).toBe(capEnabled);
        const fresh = await insertSession();
        const refreshed = await configured.refresh({
          credentialMode: "cookie",
          token: fresh.token,
          now: NOW,
          expiresAt: REFRESH_EXPIRES_AT,
        });
        expect(refreshed).not.toBeNull();
        expect(refreshed?.token === fresh.token).toBe(!rotationEnabled);
        expect(refreshed?.expiresAt).toEqual(REFRESH_EXPIRES_AT);
        const prior = await configured.observe({
          token: fresh.token,
          now: new Date(NOW.getTime() + 60_000),
          boundary: "activity",
        });
        expect(prior === null).toBe(rotationEnabled);
      }
    }
  });

  test("preserves fixed credentials and expiry under either rotation policy", async () => {
    for (const rotationEnabled of [false, true]) {
      const configured = createDatabaseSessionLifetimeStore(testDb, {
        expiresIn: 30 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
        rotationEnabled,
        capEnabled: true,
      });
      const fixture = await insertSession({
        refreshMode: "fixed",
        expiresAt: new Date(NOW.getTime() + 15 * 60_000),
      });
      const refreshed = await configured.refresh({
        credentialMode: "cookie",
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
        await configured.observe({
          token: fixture.token,
          now: new Date(NOW.getTime() + 60_001),
          boundary: "activity",
        }),
      ).not.toBeNull();
      expect(
        await configured.observe({
          token: fixture.token,
          now: fixture.expiresAt,
          boundary: "activity",
        }),
      ).toBeNull();
    }
  });

  test("extends bearer credentials without rotating them", async () => {
    const fixture = await insertSession();
    const refreshed = await store.refresh({
      credentialMode: "bearer",
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(refreshed?.token).toBe(fixture.token);
    expect(refreshed?.expiresAt).toEqual(REFRESH_EXPIRES_AT);
    const later = await store.observe({
      token: fixture.token,
      now: new Date(NOW.getTime() + 60_001),
      boundary: "activity",
    });
    expect(later?.token).toBe(fixture.token);
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.priorTokenHash).toBeNull();
  });

  test("tracks activity at five-minute intervals", async () => {
    const fixture = await insertSession({ idleMs: 0 });
    for (const elapsedMs of [0, 1, 60_000, 299_999]) {
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + elapsedMs),
        boundary: "activity",
      });
      const persisted = await testDb.query.session.findFirst({
        where: { id: { eq: fixture.id } },
      });
      expect(persisted?.lastSeenAt).toEqual(NOW);
    }
    await store.observe({
      token: fixture.token,
      now: new Date(NOW.getTime() + 300_000),
      boundary: "activity",
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
            credentialMode: "cookie",
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
      new Date(NOW.getTime() + 60_000),
    );
  });

  test("the prior credential works only before the sixty-second boundary", async () => {
    const fixture = await insertSession();
    const current = await store.refresh({
      credentialMode: "cookie",
      token: fixture.token,
      now: NOW,
      expiresAt: REFRESH_EXPIRES_AT,
    });
    expect(current).not.toBeNull();
    const grace = await store.observe({
      token: fixture.token,
      now: new Date(NOW.getTime() + 59_999),
      boundary: "activity",
    });
    expect(grace?.token).toBe(current?.token);
    for (const elapsedMs of [60_000, 60_001]) {
      expect(
        await store.observe({
          token: fixture.token,
          now: new Date(NOW.getTime() + elapsedMs),
          boundary: "activity",
        }),
      ).toBeNull();
    }
    expect(
      await store.observe({
        token: current?.token ?? "missing-credential",
        now: new Date(NOW.getTime() + 60_001),
        boundary: "activity",
      }),
    ).not.toBeNull();
  });

  test("revocation removes the current credential and its in-flight alias", async () => {
    const fixture = await insertSession();
    const current = await store.refresh({
      credentialMode: "cookie",
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
      expect(
        await store.observe({ token, now: NOW, boundary: "activity" }),
      ).toBeNull();
      expect(
        await store.refresh({
          credentialMode: "cookie",
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
      credentialMode: "cookie",
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

describe("absolute session age at startup", () => {
  const observationCases = (["startup", "activity"] as const).flatMap(
    (boundary) =>
      [90 * DAY_MS - 1, 90 * DAY_MS, 91 * DAY_MS].flatMap((ageMs) =>
        [HOUR_MS - 1, HOUR_MS, HOUR_MS + 1].map((idleMs) => ({
          boundary,
          ageMs,
          idleMs,
        })),
      ),
  );
  test.each(observationCases)(
    "%j respects both session boundaries",
    async ({ boundary, ageMs, idleMs }) => {
      const fixture = await insertSession({ ageMs, idleMs });
      const observed = await store.observe({
        token: fixture.token,
        now: NOW,
        boundary,
      });
      const refused =
        boundary === "startup" && ageMs >= 90 * DAY_MS && idleMs >= HOUR_MS;
      expect(observed === null).toBe(refused);
      const persisted = await testDb.query.session.findFirst({
        where: { id: { eq: fixture.id } },
      });
      expect(persisted?.createdAt).toEqual(fixture.createdAt);
      expect(persisted?.updatedAt).toEqual(fixture.updatedAt);
      expect(persisted?.lastSeenAt).toEqual(NOW);
      expect(persisted?.expiresAt).toEqual(refused ? NOW : fixture.expiresAt);
      if (refused) {
        expect(
          await store.observe({
            token: fixture.token,
            now: new Date(NOW.getTime() + 1),
            boundary: "activity",
          }),
        ).toBeNull();
      }
    },
  );

  test("a completed startup decision remains final for earlier request clocks", async () => {
    const fixture = await insertSession({
      ageMs: 91 * DAY_MS,
      idleMs: HOUR_MS,
    });
    expect(
      await store.observe({
        token: fixture.token,
        now: NOW,
        boundary: "startup",
      }),
    ).toBeNull();
    for (const elapsedMs of [1, 60_000, HOUR_MS]) {
      const earlier = new Date(NOW.getTime() - elapsedMs);
      expect(
        await store.observe({
          token: fixture.token,
          now: earlier,
          boundary: "activity",
        }),
      ).toBeNull();
      expect(
        await store.refresh({
          credentialMode: "cookie",
          token: fixture.token,
          now: earlier,
          expiresAt: REFRESH_EXPIRES_AT,
        }),
      ).toBeNull();
    }
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.token).toBe(fixture.token);
    expect(persisted?.priorTokenHash).toBeNull();
    expect(persisted?.lastSeenAt).toEqual(NOW);
    expect(persisted?.expiresAt).toEqual(NOW);
  });

  test("a legacy session without a real last-seen starts without an idle assumption", async () => {
    const fixture = await insertSession({ ageMs: 91 * DAY_MS, idleMs: null });
    expect(
      await store.observe({
        token: fixture.token,
        now: NOW,
        boundary: "startup",
      }),
    ).not.toBeNull();
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.lastSeenAt).toEqual(NOW);
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + HOUR_MS),
        boundary: "startup",
      }),
    ).toBeNull();
  });

  test("out-of-order observations keep the latest activity clock", async () => {
    const fixture = await insertSession({ ageMs: 91 * DAY_MS });
    const recent = new Date(NOW.getTime() + HOUR_MS);
    await store.observe({
      token: fixture.token,
      now: recent,
      boundary: "activity",
    });
    await store.observe({
      token: fixture.token,
      now: NOW,
      boundary: "activity",
    });
    const persisted = await testDb.query.session.findFirst({
      where: { id: { eq: fixture.id } },
    });
    expect(persisted?.lastSeenAt).toEqual(recent);
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(recent.getTime() + HOUR_MS - 1),
        boundary: "startup",
      }),
    ).not.toBeNull();
  });

  test("continued activity preserves an old session through later app startup", async () => {
    const fixture = await insertSession({
      ageMs: 91 * DAY_MS,
      idleMs: HOUR_MS + 1,
    });
    expect(
      await store.observe({
        token: fixture.token,
        now: NOW,
        boundary: "activity",
      }),
    ).not.toBeNull();
    expect(
      await store.observe({
        token: fixture.token,
        now: new Date(NOW.getTime() + HOUR_MS - 1),
        boundary: "startup",
      }),
    ).not.toBeNull();
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
    rotationEnabled: true,
    capEnabled: true,
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
    startup = false,
    requestCookie = cookie,
    disableCookieCache = false,
    authoritative = false,
  } = {}) =>
    await auth.handler(
      new Request(
        `http://localhost:3001/api/auth/get-session${disableCookieCache || startup ? "?disableCookieCache=true" : ""}`,
        {
          headers: {
            cookie: requestCookie,
            ...(startup ? { [AUTH_SESSION_STARTUP_HEADER]: "1" } : {}),
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
    expect(await requestCount(true)).toBe(3);
    fixture.advance(5 * 60 * 1000);
    expect(await requestCount(true)).toBe(4);
    expect(await requestCount(true)).toBe(3);
  });
  test("global before-hook authoritative resolution observes startup policy before plugin hooks", async () => {
    const fixture = await createHttpSession(true);
    await testDb
      .update(session)
      .set({
        createdAt: new Date(fixture.clock.getTime() - 91 * DAY_MS),
        lastSeenAt: new Date(fixture.clock.getTime() - HOUR_MS),
      })
      .where(eq(session.id, fixture.original.id));
    const response = await fixture.requestSession({
      startup: true,
      authoritative: true,
    });
    expect(fixture.authoritativeToken()).toBeNull();
    expect(await response.json()).toBeNull();
  });
  test.each([false, true])(
    "old idle session is refused at startup with cookie cache %s",
    async (cacheEnabled) => {
      const fixture = await createHttpSession(cacheEnabled);
      await testDb
        .update(session)
        .set({
          createdAt: new Date(fixture.clock.getTime() - 91 * DAY_MS),
          lastSeenAt: new Date(fixture.clock.getTime() - HOUR_MS),
        })
        .where(eq(session.id, fixture.original.id));
      const response = await fixture.requestSession({ startup: true });
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
    "uncached activity keeps an old idle session active with cookie cache %s",
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
      expect(await response.json()).toMatchObject({
        session: { id: fixture.original.id },
      });
      const startup = await fixture.requestSession({ startup: true });
      expect(await startup.json()).toMatchObject({
        session: { id: fixture.original.id },
      });
    },
  );
  test("native refresh forwards a new cookie and expires the prior cached credential after grace", async () => {
    const fixture = await createHttpSession(true);
    const createdAt = new Date(fixture.clock.getTime() - 91 * DAY_MS);
    await testDb
      .update(session)
      .set({
        createdAt,
        expiresAt: new Date(fixture.clock.getTime() + 28 * DAY_MS),
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
    for (const field of Object.keys(SESSION_LIFETIME_FIELDS)) {
      expect(body).not.toHaveProperty(`session.${field}`);
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
    for (const field of Object.keys(SESSION_LIFETIME_FIELDS)) {
      expect(cached).not.toHaveProperty(`session.${field}`);
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
    fixture.advance(1);
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
