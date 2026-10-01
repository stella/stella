import { runWithTransaction } from "@better-auth/core/context";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import type { Session } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
  SESSION_PRIOR_TOKEN_GRACE_MS,
} from "@/api/lib/auth/session-lifetime";
import type { SessionLifetimeStore } from "@/api/lib/auth/session-lifetime";
import { hashSessionToken } from "@/api/lib/auth/session-token";

const AUTH_BASE_URL = "http://localhost:3001";

const responseCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(
      (cookie) => cookie.split(";").at(0) ?? panic("Missing response cookie"),
    )
    .join("; ");

const createFixture = async (cacheEnabled: boolean) => {
  const sessions: Session[] = [];
  const database = {
    user: [],
    session: sessions,
    account: [],
    verification: [],
  };
  const aliases = new Map<string, { sessionId: string; expiresAt: number }>();
  let clock = new Date();
  let transactionActive = false;
  const store = {
    observe: async ({ token, now }) => {
      if (transactionActive) {
        panic(
          "Root session observation must not run inside an auth transaction",
        );
      }
      const direct = database.session.find((row) => row.token === token);
      if (direct) {
        return direct;
      }
      const alias = aliases.get(token);
      return alias && alias.expiresAt > now.getTime()
        ? (database.session.find((row) => row.id === alias.sessionId) ?? null)
        : null;
    },
    refresh: async ({ token }) =>
      database.session.find((row) => row.token === token) ?? null,
    revokeById: async ({ sessionId, userId }) => {
      database.session = database.session.filter(
        (row) => row.id !== sessionId || row.userId !== userId,
      );
    },
  } satisfies SessionLifetimeStore;
  const lifetime = createSessionLifetime({ store, now: () => clock });
  const auth = betterAuth({
    baseURL: AUTH_BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    session: {
      additionalFields: SESSION_LIFETIME_FIELDS,
      cookieCache: {
        enabled: cacheEnabled,
        maxAge: 300,
        version: lifetime.cookieCacheVersion,
      },
    },
    plugins: [
      lifetime.plugin,
      {
        id: "transaction-session-update-test",
        endpoints: {
          updateDevice: createAuthEndpoint(
            "/test-update-device",
            {
              method: "POST",
              body: v.object({ token: v.string() }),
              requireHeaders: true,
              use: [sessionMiddleware],
            },
            async (ctx) => {
              const updated = await runWithTransaction(
                ctx.context.adapter,
                async () => {
                  transactionActive = true;
                  return await ctx.context.internalAdapter
                    .updateSession(ctx.body.token, {
                      ipAddress: "203.0.113.9",
                    })
                    .finally(() => {
                      transactionActive = false;
                    });
                },
              );
              return ctx.json({ sessionId: updated?.id ?? null });
            },
          ),
        },
      },
    ],
  });
  const signedIn = await auth.api.signUpEmail({
    body: {
      email: "caller@example.test",
      name: "Caller",
      password: "A secure password 123!",
    },
    asResponse: true,
  });
  expect(signedIn.status).toBe(200);
  const cookie = responseCookies(signedIn);
  expect(cookie).not.toBe("");
  const caller = database.session.at(0) ?? panic("Caller session missing");
  const context = await auth.$context;
  const createOtherDevice = async () => {
    const created = await context.internalAdapter.createSession(caller.userId);
    return (
      database.session.find((row) => row.id === created.id) ??
      panic("Other device missing")
    );
  };
  const rotate = (row: Session) => {
    const oldToken = row.token;
    aliases.set(oldToken, {
      sessionId: row.id,
      expiresAt: clock.getTime() + SESSION_PRIOR_TOKEN_GRACE_MS,
    });
    row.token = Bun.randomUUIDv7();
    Object.assign(row, {
      priorTokenHash: hashSessionToken(oldToken),
      priorTokenExpiresAt: new Date(
        clock.getTime() + SESSION_PRIOR_TOKEN_GRACE_MS,
      ),
    });
    return oldToken;
  };
  const post = async (path: string, body: object) =>
    await auth.handler(
      new Request(`${AUTH_BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: AUTH_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  return {
    auth,
    context,
    database,
    caller,
    cookie,
    createOtherDevice,
    rotate,
    post,
    advance: (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    },
  };
};

describe("session revocation through HTTP", () => {
  test.each(["current", "prior"] as const)(
    "updates a device by its %s token through the SDK transaction adapter",
    async (tokenMode) => {
      const fixture = await createFixture(false);
      const target = await fixture.createOtherDevice();
      const token =
        tokenMode === "prior" ? fixture.rotate(target) : target.token;
      if (tokenMode === "prior") {
        expect(token).not.toBe(target.token);
      }
      const response = await fixture.post("/test-update-device", { token });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: target.id });
      expect(
        fixture.database.session.find((row) => row.id === target.id)?.ipAddress,
      ).toBe("203.0.113.9");
      expect(
        fixture.database.session.find((row) => row.id === fixture.caller.id)
          ?.ipAddress,
      ).not.toBe("203.0.113.9");
    },
  );

  test.each([false, true])(
    "reissues a rotated alias only for its own signed cookie with cache %s",
    async (cacheEnabled) => {
      const fixture = await createFixture(cacheEnabled);
      const oldToken = fixture.rotate(fixture.caller);
      expect(fixture.caller.token).not.toBe(oldToken);
      const response = await fixture.auth.handler(
        new Request(
          `${AUTH_BASE_URL}/api/auth/get-session?disableCookieCache=true`,
          {
            headers: { cookie: fixture.cookie },
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        session: { id: fixture.caller.id },
      });
      const cookieName = fixture.context.authCookies.sessionToken.name;
      expect(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith(`${cookieName}=`)),
      ).toBe(true);
      const refreshedCookie = responseCookies(response);
      expect(refreshedCookie).not.toBe(fixture.cookie);
      fixture.advance(SESSION_PRIOR_TOKEN_GRACE_MS + 1);
      expect(
        await fixture.auth.api.getSession({
          headers: { cookie: refreshedCookie },
          query: { disableCookieCache: true },
        }),
      ).toMatchObject({ session: { id: fixture.caller.id } });
      expect(
        await fixture.auth.api.getSession({
          headers: { cookie: fixture.cookie },
          query: { disableCookieCache: true },
        }),
      ).toBeNull();
    },
  );

  test.each([false, true])(
    "revoking another device's rotated alias preserves the caller cookie with cache %s",
    async (cacheEnabled) => {
      const fixture = await createFixture(cacheEnabled);
      const other = await fixture.createOtherDevice();
      const oldToken = fixture.rotate(other);
      expect(other.token).not.toBe(oldToken);
      const response = await fixture.post("/revoke-session", {
        token: oldToken,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: true });
      expect(fixture.database.session.some((row) => row.id === other.id)).toBe(
        false,
      );
      const cookieName = fixture.context.authCookies.sessionToken.name;
      expect(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith(`${cookieName}=`)),
      ).toBe(false);
      expect(
        await fixture.auth.api.getSession({
          headers: { cookie: fixture.cookie },
          query: { disableCookieCache: true },
        }),
      ).toMatchObject({ session: { id: fixture.caller.id } });
    },
  );

  test("revokes a listed device by stable ID after its old token grace expires", async () => {
    const fixture = await createFixture(true);
    const other = await fixture.createOtherDevice();
    const listed = await fixture.auth.api.listSessions({
      headers: { cookie: fixture.cookie },
    });
    expect(
      listed.some((row) => row.id === other.id && row.token === other.token),
    ).toBe(true);
    const oldToken = fixture.rotate(other);
    fixture.advance(SESSION_PRIOR_TOKEN_GRACE_MS + 1);
    expect(
      await fixture.context.internalAdapter.findSession(oldToken),
    ).toBeNull();
    const response = await fixture.post("/revoke-session-by-id", {
      sessionId: other.id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(fixture.database.session.some((row) => row.id === other.id)).toBe(
      false,
    );
    expect(
      await fixture.auth.api.getSession({
        headers: { cookie: fixture.cookie },
        query: { disableCookieCache: true },
      }),
    ).toMatchObject({ session: { id: fixture.caller.id } });
  });

  test("refuses to revoke a session belonging to another user", async () => {
    const fixture = await createFixture(false);
    const otherUser = await fixture.context.internalAdapter.createUser(
      {
        email: "other@example.test",
        name: "Other",
        emailVerified: true,
      },
      { method: "email-password" },
    );
    const otherSession = await fixture.context.internalAdapter.createSession(
      otherUser.id,
    );
    const response = await fixture.post("/revoke-session-by-id", {
      sessionId: otherSession.id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(
      fixture.database.session.some(
        (row) => row.id === otherSession.id && row.userId === otherUser.id,
      ),
    ).toBe(true);
  });
});
