import { betterAuth } from "better-auth";
import type { Session } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import { panic } from "better-result";
import { describe, expect, setSystemTime, test } from "bun:test";
import Elysia from "elysia";

import {
  createAuthResponseCookiesPlugin,
  forwardAuthResponseCookies,
} from "@/api/lib/auth/auth-response-cookies";
import { createSessionBearer } from "@/api/lib/auth/session-bearer";
import { createSessionLifetime } from "@/api/lib/auth/session-lifetime";
import type { SessionLifetimeStore } from "@/api/lib/auth/session-lifetime";

describe("session cookie forwarding", () => {
  test.each(["cookie", "bearer"] as const)(
    "keeps native refresh credentials usable for %s requests",
    async (credentialMode) => {
      let clock = new Date("2026-10-01T12:00:00.000Z");
      setSystemTime(clock);
      try {
        const sessions: Session[] = [];
        const database = {
          user: [],
          session: sessions,
          account: [],
          verification: [],
        };
        const refreshedModes: string[] = [];
        const store = {
          observe: async ({ token }) =>
            database.session.find((current) => current.token === token) ?? null,
          refresh: async ({ token, expiresAt, now, credentialMode: mode }) => {
            const current = database.session.find((row) => row.token === token);
            if (!current) {
              return null;
            }
            refreshedModes.push(mode);
            const updated = {
              ...current,
              expiresAt,
              updatedAt: now,
              token: mode === "bearer" ? token : "replacement-session-token",
            };
            database.session = [updated];
            return updated;
          },
          revokeById: async ({ sessionId, userId }) => {
            database.session = database.session.filter(
              (row) => row.id !== sessionId || row.userId !== userId,
            );
          },
        } satisfies SessionLifetimeStore;
        const lifetime = createSessionLifetime({ store, now: () => clock });
        const auth = betterAuth({
          baseURL: "http://localhost:3001",
          secret: "test-secret-that-is-long-enough-for-better-auth",
          database: memoryAdapter(database),
          emailAndPassword: { enabled: true },
          session: { expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
          plugins: [createSessionBearer(), lifetime.plugin],
          hooks: {
            before: createAuthMiddleware(async (ctx) => {
              lifetime.prepare(ctx.context);
              await Promise.resolve();
            }),
          },
        });
        const signup = await auth.api.signUpEmail({
          body: {
            email: "account@example.test",
            name: "Account",
            password: "Fixture password 123!",
          },
          asResponse: true,
        });
        expect(signup.status).toBe(200);
        expect(signup.headers.get("set-auth-token")).toBeNull();
        const cookie = signup.headers
          .getSetCookie()
          .map((value) => value.split(";").at(0))
          .join("; ");
        const signed =
          getSessionCookie(new Headers({ cookie })) ??
          panic("Sign-up did not issue a session cookie");
        const original =
          database.session.at(0) ?? panic("Sign-up did not create a session");
        database.session = [
          {
            ...original,
            expiresAt: new Date(clock.getTime() + 24 * 60 * 60 * 1000),
          },
        ];
        const app = new Elysia()
          .use(createAuthResponseCookiesPlugin())
          .get("/", async ({ request, set }) => {
            const resolved = await auth.api.getSession({
              headers: request.headers,
              returnHeaders: true,
            });
            forwardAuthResponseCookies(set.headers, resolved.headers);
            return new Response(resolved.response ? "ready" : "unavailable", {
              headers: { "set-cookie": "route=kept; Path=/" },
            });
          });
        const requestHeaders =
          credentialMode === "bearer"
            ? { authorization: `Bearer ${signed}` }
            : { cookie };
        const response = await app.handle(
          new Request("http://localhost/", { headers: requestHeaders }),
        );
        expect(await response.text()).toBe("ready");
        expect(refreshedModes).toEqual([credentialMode]);
        expect(response.headers.get("set-auth-token")).toBeNull();
        const current =
          database.session.at(0) ?? panic("Refresh removed the session");
        expect(current.expiresAt.getTime()).toBeGreaterThan(
          clock.getTime() + 29 * 24 * 60 * 60 * 1000,
        );
        expect(current.token === original.token).toBe(
          credentialMode === "bearer",
        );
        clock = new Date(clock.getTime() + 61_000);
        setSystemTime(clock);
        const refreshedCookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";").at(0))
          .join("; ");
        const followupHeaders =
          credentialMode === "bearer"
            ? requestHeaders
            : { cookie: refreshedCookie };
        const followup = await app.handle(
          new Request("http://localhost/", { headers: followupHeaders }),
        );
        expect(await followup.text()).toBe("ready");
        expect(followup.headers.get("set-auth-token")).toBeNull();
        const unsigned = await auth.api.getSession({
          headers: { authorization: `Bearer ${current.token}` },
        });
        expect(unsigned).toBeNull();
      } finally {
        setSystemTime();
      }
    },
  );

  test.each(["response", "sse"] as const)(
    "appends forwarded cookies to a %s route's own cookies",
    async (kind) => {
      const authHeaders = new Headers();
      authHeaders.append("set-cookie", "session=new; HttpOnly; Path=/");
      authHeaders.append("set-cookie", "snapshot=new; HttpOnly; Path=/");
      const body = kind === "sse" ? "data: ready\n\n" : "ready";
      const app = new Elysia()
        .use(createAuthResponseCookiesPlugin())
        .get("/", ({ set }) => {
          set.headers["set-cookie"] = "middleware=kept; Path=/";
          forwardAuthResponseCookies(set.headers, authHeaders);
          const responseHeaders = new Headers({
            "content-type": kind === "sse" ? "text/event-stream" : "text/plain",
          });
          responseHeaders.append(
            "set-cookie",
            "route=kept; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
          );
          if (kind === "sse") {
            responseHeaders.set("transfer-encoding", "chunked");
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
              },
            });
            return new Response(stream, { headers: responseHeaders });
          }
          return new Response(body, { headers: responseHeaders });
        });
      const response = await app.handle(new Request("http://localhost/"));
      expect(response.headers.getSetCookie()).toEqual([
        "route=kept; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
        "middleware=kept; Path=/",
        "session=new; HttpOnly; Path=/",
        "snapshot=new; HttpOnly; Path=/",
      ]);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("content-type")).toBe(
        kind === "sse" ? "text/event-stream" : "text/plain",
      );
    },
  );

  test("preserves separate cookies and existing response cookies through HTTP", async () => {
    const authHeaders = new Headers();
    authHeaders.append("set-cookie", "session=new; HttpOnly; Path=/");
    authHeaders.append(
      "set-cookie",
      "snapshot=value; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
    );
    const app = new Elysia()
      .use(createAuthResponseCookiesPlugin())
      .get("/", ({ set }) => {
        set.headers["set-cookie"] = "existing=kept; Path=/";
        set.headers["x-existing"] = "kept";
        forwardAuthResponseCookies(set.headers, authHeaders);
        forwardAuthResponseCookies(
          set.headers,
          new Headers({ "set-cookie": "another=kept; Path=/" }),
        );
        return "ok";
      });
    const response = await app.handle(new Request("http://localhost/"));
    expect(response.headers.getSetCookie()).toEqual([
      "existing=kept; Path=/",
      "session=new; HttpOnly; Path=/",
      "snapshot=value; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
      "another=kept; Path=/",
    ]);
    expect(response.headers.get("x-existing")).toBe("kept");
  });

  test("leaves response headers unchanged when no auth cookie was issued", () => {
    const headers = {
      "set-cookie": "existing=kept; Path=/",
      "x-existing": "kept",
    };
    forwardAuthResponseCookies(
      headers,
      new Headers({ "set-auth-token": "unused-credential-header" }),
    );
    expect(headers).toEqual({
      "set-cookie": "existing=kept; Path=/",
      "x-existing": "kept",
    });
  });
});
