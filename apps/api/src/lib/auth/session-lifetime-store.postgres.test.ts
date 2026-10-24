import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { account, session, user, verification } from "@/api/db/auth-schema";
import { revokeUserSessionById } from "@/api/lib/auth-artifacts";
import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
  SESSION_PRIOR_TOKEN_RECOVERY_MS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { createSignedSessionCookieValue } from "@/api/lib/auth/signed-session-cookie";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { mintSmokeSession } from "@/api/lib/smoke-session/store";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const DAY_MS = 24 * 60 * 60 * 1000;
const configuredPolicy = {
  expiresIn: 30 * 24 * 60 * 60,
  updateAge: 24 * 60 * 60,
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("session lifetime on the migrated schema (postgres)", () => {
    test("requires the PostgreSQL suite", () => {});
  });
} else {
  describe("session lifetime on the migrated schema (postgres)", () => {
    test.each(["confirmation", "ceiling"] as const)(
      "a dropped rotation response remains usable until %s",
      async (termination) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          let clock = new Date();
          const rotatedAt = clock.getTime();
          const userId = mintAuthProviderIdValue();
          const sessionId = mintAuthProviderIdValue();
          const token = mintAuthProviderIdValue();
          const secret = "session-postgres-secret-with-at-least-32-characters";
          await db.insert(user).values({
            id: userId,
            name: "Session fixture",
            email: `${userId}@session.test`,
          });
          try {
            await db.insert(session).values({
              id: sessionId,
              userId,
              token,
              refreshMode: "automatic",
              createdAt: new Date(clock.getTime() - 2 * DAY_MS),
              updatedAt: new Date(clock.getTime() - 2 * DAY_MS),
              lastSeenAt: clock,
              expiresAt: new Date(clock.getTime() + DAY_MS),
            });
            const lifetime = createSessionLifetime({
              store: createDatabaseSessionLifetimeStore(db, configuredPolicy),
              now: () => clock,
            });
            const auth = betterAuth({
              baseURL: "http://localhost:3001",
              secret,
              database: drizzleAdapter(db, {
                provider: "pg",
                schema: { account, session, user, verification },
              }),
              session: {
                ...configuredPolicy,
                additionalFields: SESSION_LIFETIME_FIELDS,
                cookieCache: { enabled: false },
              },
              plugins: [lifetime.plugin],
            });
            const oldCookie = `better-auth.session_token=${encodeURIComponent(createSignedSessionCookieValue(token, secret))}`;
            const read = async (cookie: string) =>
              await auth.handler(
                new Request("http://localhost:3001/api/auth/get-session", {
                  headers: { cookie },
                }),
              );
            const rotation = await read(oldCookie);
            expect(rotation.status).toBe(200);
            const rotated = await rotation.json();
            expect(rotated).toMatchObject({ session: { id: sessionId } });
            const newCookie = rotation.headers
              .getSetCookie()
              .map((value) => value.split(";").at(0))
              .join("; ");
            expect(newCookie).toContain("session_token=");
            expect(newCookie).not.toContain(
              encodeURIComponent(createSignedSessionCookieValue(token, secret)),
            );
            // Drop every replacement Set-Cookie; subsequent requests still carry the old jar.
            clock = new Date(rotatedAt + 2 * 60_000);
            const retry = await read(oldCookie);
            expect(await retry.json()).toMatchObject({
              session: { id: sessionId },
            });
            clock = new Date(rotatedAt + SESSION_PRIOR_TOKEN_RECOVERY_MS - 1);
            expect(await (await read(oldCookie)).json()).toMatchObject({
              session: { id: sessionId },
            });
            if (termination === "confirmation") {
              expect(await (await read(newCookie)).json()).toMatchObject({
                session: { id: sessionId },
              });
            } else {
              clock = new Date(rotatedAt + SESSION_PRIOR_TOKEN_RECOVERY_MS);
            }
            expect(await (await read(oldCookie)).json()).toBeNull();
            expect(await (await read(newCookie)).json()).toMatchObject({
              session: { id: sessionId },
            });
          } finally {
            await db.delete(user).where(eq(user.id, userId));
          }
        });
      },
    );

    test("independent connections converge on one refreshed credential", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = openClient();
        const second = openClient();
        const firstBackend = await first.sql`SELECT pg_backend_pid() AS pid`;
        const secondBackend = await second.sql`SELECT pg_backend_pid() AS pid`;
        expect(firstBackend.at(0)?.pid).not.toBe(secondBackend.at(0)?.pid);
        const userId = mintAuthProviderIdValue();
        const sessionId = mintAuthProviderIdValue();
        const token = mintAuthProviderIdValue();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 7 * DAY_MS);
        await first.db.insert(user).values({
          id: userId,
          name: "Session fixture",
          email: `${userId}@session.test`,
        });
        try {
          await first.db.insert(session).values({
            id: sessionId,
            userId,
            token,
            refreshMode: "automatic",
            createdAt: new Date(now.getTime() - 2 * DAY_MS),
            updatedAt: new Date(now.getTime() - 2 * DAY_MS),
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + DAY_MS),
          });
          const firstStore = createDatabaseSessionLifetimeStore(
            first.db,
            configuredPolicy,
          );
          const secondStore = createDatabaseSessionLifetimeStore(
            second.db,
            configuredPolicy,
          );
          const results = await Promise.all([
            firstStore.refresh({
              token,
              now,
              expiresAt,
            }),
            secondStore.refresh({
              token,
              now,
              expiresAt,
            }),
          ]);
          const current =
            results.at(0) ??
            panic("Refresh did not return the fixture session");
          expect(current.token).not.toBe(token);
          for (const result of results) {
            expect(result?.id).toBe(sessionId);
            expect(result?.token).toBe(current.token);
            expect(result?.expiresAt).toEqual(expiresAt);
          }
        } finally {
          await first.db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    test("a smoke-minted credential remains usable beyond sixty seconds", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const minted = await mintSmokeSession("default");
        const token =
          minted.cookieValue.split(".").at(0) ??
          panic("Mint returned no credential");
        try {
          const initial = await db.query.session.findFirst({
            where: { token: { eq: token } },
          });
          if (!initial) {
            panic("Mint did not persist the fixture session");
          }
          expect(initial.refreshMode).toBe("fixed");
          const store = createDatabaseSessionLifetimeStore(
            db,
            configuredPolicy,
          );
          const refreshed = await store.refresh({
            token,
            now: initial.createdAt,
            expiresAt: new Date(initial.createdAt.getTime() + 7 * DAY_MS),
          });
          expect(refreshed?.token).toBe(token);
          expect(refreshed?.expiresAt).toEqual(initial.expiresAt);
          const later = await store.observe({
            token,
            now: new Date(initial.createdAt.getTime() + 60_001),
          });
          expect(later?.id).toBe(initial.id);
          expect(later?.token).toBe(token);
        } finally {
          const remaining = await db.query.session.findFirst({
            where: { token: { eq: token } },
          });
          if (remaining) {
            await revokeUserSessionById(db, {
              sessionId: remaining.id,
              userId: brandPersistedUserId(remaining.userId),
            });
          }
        }
      });
    });
  });
}
