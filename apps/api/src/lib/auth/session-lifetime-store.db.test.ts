import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { getCookieCache } from "better-auth/cookies";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { AUTH_SESSION_STARTUP_HEADER } from "@stll/auth-model";

import { account, session, user, verification } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
} from "@/api/lib/auth/session-lifetime";
import {
  createDatabaseSessionLifetimeStore,
  hashSessionToken,
} from "@/api/lib/auth/session-lifetime-store";
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
  ageMs?: number;
  idleMs?: number | null;
  expiresAt?: Date;
};

const insertSession = async ({
  ageMs = DAY_MS,
  idleMs = HOUR_MS,
  expiresAt = new Date(NOW.getTime() + DAY_MS),
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
  };
  await testDb.insert(session).values(fixture);
  return fixture;
};

describe("session refresh credentials", () => {
  test("simultaneous refreshes converge without changing the session identity or age", async () => {
    const fixture = await insertSession();
    const refreshed = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.refresh({
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
      where: eq(session.id, fixture.id),
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
        await store.refresh({ token, now: NOW, expiresAt: REFRESH_EXPIRES_AT }),
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
      where: eq(session.id, fixture.id),
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
        where: eq(session.id, fixture.id),
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
          token: fixture.token,
          now: earlier,
          expiresAt: REFRESH_EXPIRES_AT,
        }),
      ).toBeNull();
    }
    const persisted = await testDb.query.session.findFirst({
      where: eq(session.id, fixture.id),
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
      where: eq(session.id, fixture.id),
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
      where: eq(session.id, fixture.id),
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
  let authoritativeToken: string | null | undefined;
  let resolvedSessionToken: string | null | undefined;
  const lifetime = createSessionLifetime({ store, now: () => clock });
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: AUTH_SECRET,
    database: drizzleAdapter(asTestRaw<typeof rootDb>(testDb), {
      provider: "pg",
      schema: { account, session, user, verification },
    }),
    emailAndPassword: { enabled: true },
    session: {
      additionalFields: SESSION_LIFETIME_FIELDS,
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: {
        enabled: cacheEnabled,
        maxAge: 300,
        version: lifetime.cookieCacheVersion,
      },
    },
    plugins: [lifetime.plugin],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/get-session") {
          resolvedSessionToken = ctx.context.session?.session.token ?? null;
        }
        await Promise.resolve();
      }),
      before: createAuthMiddleware(async (ctx) => {
        lifetime.prepare(ctx.context.internalAdapter);
        if (ctx.headers?.get("x-stella-test-authoritative") === "1") {
          const resolved = await getAuthoritativeSessionFromCtx(ctx);
          authoritativeToken = resolved?.session.token ?? null;
        }
      }),
    },
  });
  const email = `${mintAuthProviderIdValue()}@http-session.test`;
  const signup = await auth.handler(
    new Request("http://localhost:3001/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify({
        email,
        name: "Session fixture",
        password: "Fixture password 123!",
      }),
    }),
  );
  expect(signup.status).toBe(200);
  const accountUser = await testDb.query.user.findFirst({
    where: eq(user.email, email),
  });
  const userId =
    accountUser?.id ?? panic("Sign-up did not create the fixture user");
  fixtureUsers.push(userId);
  const created = await testDb.query.session.findFirst({
    where: eq(session.userId, userId),
  });
  const original =
    created ?? panic("Sign-up did not create the fixture session");
  const cookie = responseCookies(signup);
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
        `http://localhost:3001/api/auth/get-session${disableCookieCache ? "?disableCookieCache=true" : ""}`,
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
    },
  };
};

describe("native authentication session responses", () => {
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
    },
  );

  test.each([false, true])(
    "ordinary refetch keeps an old idle session active with cookie cache %s",
    async (cacheEnabled) => {
      const fixture = await createHttpSession(cacheEnabled);
      await testDb
        .update(session)
        .set({
          createdAt: new Date(fixture.clock.getTime() - 91 * DAY_MS),
          lastSeenAt: new Date(fixture.clock.getTime() - HOUR_MS),
        })
        .where(eq(session.id, fixture.original.id));
      const response = await fixture.requestSession();
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
      where: eq(session.id, fixture.original.id),
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
    const inFlight = await fixture.requestSession();
    expect(await inFlight.json()).toMatchObject({
      session: { token: current.token },
    });
    expect(responseCookies(inFlight)).toContain("session_token=");
    fixture.advance(1);
    const stale = await fixture.requestSession();
    expect(await stale.json()).toBeNull();
    const active = await fixture.requestSession({
      requestCookie: refreshedCookie,
    });
    expect(await active.json()).toMatchObject({
      session: { id: fixture.original.id, token: current.token },
    });
  });
});
