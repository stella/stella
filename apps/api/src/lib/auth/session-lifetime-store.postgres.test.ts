import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { session, user } from "@/api/db/auth-schema";
import { revokeUserSessionById } from "@/api/lib/auth-artifacts";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { mintSmokeSession } from "@/api/lib/smoke-session/store";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const DAY_MS = 24 * 60 * 60 * 1000;
const configuredPolicy = {
  expiresIn: 7 * 24 * 60 * 60,
  updateAge: 24 * 60 * 60,
  rotationEnabled: true,
  capEnabled: true,
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("session lifetime on the migrated schema (postgres)", () => {
    test("requires the PostgreSQL suite", () => {});
  });
} else {
  describe("session lifetime on the migrated schema (postgres)", () => {
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
            createdAt: now,
            updatedAt: now,
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
              credentialMode: "cookie",
              token,
              now,
              expiresAt,
            }),
            secondStore.refresh({
              credentialMode: "cookie",
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
            credentialMode: "cookie",
            token,
            now: initial.createdAt,
            expiresAt: new Date(initial.createdAt.getTime() + 7 * DAY_MS),
          });
          expect(refreshed?.token).toBe(token);
          expect(refreshed?.expiresAt).toEqual(initial.expiresAt);
          const later = await store.observe({
            token,
            now: new Date(initial.createdAt.getTime() + 60_001),
            boundary: "activity",
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
