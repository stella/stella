import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { DAY_IN_MS } from "@stll/time";

import {
  agentRegistration,
  agentAssertionReplay,
} from "@/api/db/agent-auth-schema";
import {
  oauthClient,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
  oauthClientAssertion,
  verification,
  user,
} from "@/api/db/auth-schema";
import { registrationDailyBudget } from "@/api/db/registration-budget-schema";
import {
  REGISTRATION_RETENTION_BATCH_SIZE,
  UNUSED_CLIENT_RETENTION_DAYS,
  sweepRegistrations,
} from "@/api/lib/scheduler/tasks/registration-retention";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const NOW = new Date("2026-10-03T12:00:00Z");
const OLD = new Date(
  NOW.getTime() - (UNUSED_CLIENT_RETENTION_DAYS + 1) * DAY_IN_MS,
);
const FUTURE = new Date(NOW.getTime() + DAY_IN_MS);
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});
afterAll(async () => await client.close());
beforeEach(async () => {
  await db.delete(verification).where(sql`true`);
  await db.delete(oauthClientAssertion).where(sql`true`);
  await db.delete(agentRegistration).where(sql`true`);
  await db.delete(agentAssertionReplay).where(sql`true`);
  await db.delete(oauthClient).where(sql`true`);
  await db.delete(registrationDailyBudget).where(sql`true`);
  await db.delete(user).where(sql`true`);
});

const addClient = async (
  clientId: string,
  options: {
    registrationOrigin?: "managed" | "open-client" | "agent";
    createdAt?: Date;
    updatedAt?: Date;
    clientDiscoveryId?: string;
  } = {},
) => {
  await db.insert(oauthClient).values({
    id: clientId,
    clientId,
    redirectUris: [],
    registrationOrigin: "open-client",
    createdAt: OLD,
    updatedAt: OLD,
    ...options,
  });
};
const addRegistration = async (
  clientId: string,
  options: {
    expiresAt?: Date;
    status?: string;
    boundUserId?: string;
  } = {},
) => {
  await db.insert(agentRegistration).values({
    id: clientId,
    clientId,
    registrationType: "anonymous",
    claimTokenHash: clientId,
    clientSecretSink:
      asTestRaw<typeof agentRegistration.$inferInsert.clientSecretSink>(
        "stored-value",
      ),
    expiresAt: OLD,
    ...options,
  });
};
const sweep = async (activityClientId?: string) =>
  await sweepRegistrations({
    db: asTestRaw<SchedulerDb>({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        await db.transaction(
          async (tx) =>
            await callback({
              execute: async (query: SQL) => {
                const rows = (await tx.execute(query)).rows;
                if (
                  activityClientId !== undefined &&
                  new PgDialect()
                    .sqlToQuery(query)
                    .sql.includes("FOR UPDATE OF c SKIP LOCKED")
                ) {
                  expect(rows).toHaveLength(1);
                  await tx
                    .update(oauthClient)
                    .set({ updatedAt: NOW })
                    .where(eq(oauthClient.clientId, activityClientId));
                }
                return rows;
              },
            }),
        ),
    }),
    now: NOW,
  });
const remaining = async () =>
  (await db.select({ clientId: oauthClient.clientId }).from(oauthClient))
    .map(({ clientId }) => clientId)
    .toSorted();

test("expires unclaimed registrations and unused clients at a fixed point", async () => {
  await addClient("expired", { registrationOrigin: "agent", createdAt: NOW });
  await addRegistration("expired");
  await addRegistration("orphan");
  await addClient("unused");
  await addClient("unused-agent", { registrationOrigin: "agent" });
  await addClient("document", {
    registrationOrigin: "managed",
    clientDiscoveryId: "metadata",
  });
  await addClient("current", { createdAt: NOW });
  await addClient("managed", { registrationOrigin: "managed" });
  await addClient("pending", { registrationOrigin: "agent" });
  await addRegistration("pending", { expiresAt: FUTURE });
  await addClient("claimed", { registrationOrigin: "agent" });
  await addRegistration("claimed", {
    status: "confirmed",
    boundUserId: "member",
  });
  await db.insert(registrationDailyBudget).values([
    { day: OLD, kind: "agent", count: 10 },
    { day: NOW, kind: "agent", count: 10 },
  ]);
  expect(await sweep()).toEqual({
    verificationsDeleted: 0,
    assertionsDeleted: 0,
    replaysDeleted: 0,
    registrationsDeleted: 2,
    clientsDeleted: 4,
    budgetsDeleted: 1,
    hasMore: false,
  });
  expect(await remaining()).toEqual([
    "claimed",
    "current",
    "managed",
    "pending",
  ]);
  expect(await sweep()).toEqual({
    verificationsDeleted: 0,
    assertionsDeleted: 0,
    replaysDeleted: 0,
    registrationsDeleted: 0,
    clientsDeleted: 0,
    budgetsDeleted: 0,
    hasMore: false,
  });
  expect((await db.select().from(registrationDailyBudget)).length).toBe(1);
});

test("keeps clients with any consent or token and active authorization", async () => {
  await db.insert(user).values({
    id: "member",
    name: "Member",
    email: "member@example.test",
    emailVerified: true,
  });
  for (const name of [
    "consent",
    "access",
    "refresh",
    "authorization",
    "expired-code",
  ]) {
    await addClient(name);
  }
  await db
    .insert(oauthConsent)
    .values({ id: "consent", clientId: "consent", scopes: [] });
  await db.insert(oauthAccessToken).values({
    id: "access",
    token: "access",
    clientId: "access",
    scopes: [],
    expiresAt: OLD,
  });
  await db.insert(oauthRefreshToken).values({
    id: "refresh",
    token: "refresh",
    clientId: "refresh",
    userId: "member",
    scopes: [],
    expiresAt: OLD,
  });
  await db.insert(verification).values([
    {
      id: "authorization",
      identifier: "authorization",
      value: JSON.stringify({
        type: "authorization_code",
        query: { client_id: "authorization" },
      }),
      expiresAt: FUTURE,
    },
    {
      id: "expired-code",
      identifier: "expired-code",
      value: JSON.stringify({
        type: "authorization_code",
        query: { client_id: "expired-code" },
      }),
      expiresAt: OLD,
    },
    {
      id: "email",
      identifier: "email",
      value: "email-value",
      expiresAt: FUTURE,
    },
  ]);
  expect((await sweep()).clientsDeleted).toBe(1);
  expect(await remaining()).toEqual([
    "access",
    "authorization",
    "consent",
    "refresh",
  ]);
  expect((await db.select().from(agentRegistration)).length).toBe(0);
  expect((await db.select().from(oauthConsent)).length).toBe(1);
  expect((await db.select().from(oauthAccessToken)).length).toBe(1);
  expect((await db.select().from(oauthRefreshToken)).length).toBe(1);
  expect((await db.select().from(verification)).length).toBe(2);
});

test("bounds each committed batch and drains the persisted remainder", async () => {
  await db.insert(oauthClient).values(
    Array.from({ length: REGISTRATION_RETENTION_BATCH_SIZE + 1 }, (_, i) => ({
      id: `client-${i}`,
      clientId: `client-${i}`,
      redirectUris: [],
      registrationOrigin: "open-client" as const,
      createdAt: OLD,
      updatedAt: OLD,
    })),
  );
  const first = await sweep();
  expect(first.clientsDeleted).toBe(REGISTRATION_RETENTION_BATCH_SIZE);
  expect(first.hasMore).toBe(true);
  expect((await remaining()).length).toBe(1);
  expect((await sweep()).clientsDeleted).toBe(1);
  expect(await remaining()).toEqual([]);
});

test("holds recent registrations at the retention boundary", async () => {
  await addClient("boundary", {
    createdAt: new Date(
      NOW.getTime() - UNUSED_CLIENT_RETENTION_DAYS * DAY_IN_MS,
    ),
  });
  expect((await sweep()).clientsDeleted).toBe(0);
  expect(
    await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "boundary")),
  ).toHaveLength(1);
});

test("expires transient values in bounded replay-safe batches", async () => {
  await db.insert(oauthClientAssertion).values([
    { id: "expired", expiresAt: OLD },
    { id: "active", expiresAt: FUTURE },
  ]);
  await db.insert(verification).values([
    { id: "expired", identifier: "expired", value: "value", expiresAt: OLD },
    { id: "active", identifier: "active", value: "value", expiresAt: FUTURE },
  ]);
  await db.insert(agentAssertionReplay).values([
    { jti: "expired", expiresAt: OLD },
    { jti: "active", expiresAt: FUTURE },
  ]);
  const result = await sweep();
  expect(result.replaysDeleted).toBe(1);
  expect(
    (await db.select().from(agentAssertionReplay)).map(({ jti }) => jti),
  ).toEqual(["active"]);
  expect(result.assertionsDeleted).toBe(1);
  expect(result.verificationsDeleted).toBe(1);
  expect(
    (await db.select().from(oauthClientAssertion)).map(({ id }) => id),
  ).toEqual(["active"]);
  expect((await db.select().from(verification)).map(({ id }) => id)).toEqual([
    "active",
  ]);
  expect((await sweep()).verificationsDeleted).toBe(0);
});

test("preserves clients while active authorization has unresolved fields", async () => {
  await addClient("unused");
  for (const value of [
    JSON.stringify({ type: "authorization_code" }),
    '{"type":"authorization_code"',
  ]) {
    await db.insert(verification).values({
      id: "unresolved",
      identifier: "unresolved",
      value,
      expiresAt: FUTURE,
    });
    expect((await sweep()).clientsDeleted).toBe(0);
    expect(await remaining()).toEqual(["unused"]);
    await db.delete(verification).where(eq(verification.id, "unresolved"));
  }
  expect((await sweep()).clientsDeleted).toBe(1);
});

test("keeps clients with recent activity before authorization completes", async () => {
  await addClient("active", { updatedAt: NOW });
  expect((await sweep()).clientsDeleted).toBe(0);
  expect(await remaining()).toEqual(["active"]);
});

test("rechecks client activity after selecting a batch", async () => {
  await addClient("active");
  expect((await sweep("active")).clientsDeleted).toBe(0);
  expect(await remaining()).toEqual(["active"]);
});
