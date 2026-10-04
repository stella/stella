import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import { AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS } from "@/api/agent-auth/id-jag-policy";
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
import { envApiServerSchema } from "@/api/env-schema";
import {
  REGISTRATION_RETENTION_BATCH_SIZE,
  sweepRegistrations,
} from "@/api/lib/scheduler/tasks/registration-retention";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const retentionDays = v.parse(
  envApiServerSchema.UNUSED_CLIENT_RETENTION_DAYS,
  "7",
);
const NOW = new Date("2026-10-03T12:00:00Z");
const OLD = new Date(NOW.getTime() - (retentionDays + 1) * DAY_IN_MS);
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
    registrationOrigin?: typeof oauthClient.$inferInsert.registrationOrigin;
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
    retentionDays,
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
    registrationOrigin: "open-client",
    clientDiscoveryId: "metadata",
  });
  await addClient("current", { createdAt: NOW });
  await addClient("managed", { registrationOrigin: "managed" });
  await addClient("managed-document", {
    registrationOrigin: "managed",
    clientDiscoveryId: "metadata",
  });
  await addClient("historical", { registrationOrigin: "historical" });
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
    clientsDeleted: 5,
    budgetsDeleted: 1,
    hasMore: false,
  });
  expect(await remaining()).toEqual([
    "claimed",
    "current",
    "managed",
    "managed-document",
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

test("keeps clients with consent, live access tokens, refresh tokens or active authorization", async () => {
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
    "expired-access",
    "boundary-access",
  ]) {
    await addClient(name);
  }
  await addClient("historical-consent", { registrationOrigin: "historical" });
  await db.insert(oauthConsent).values({
    id: "historical-consent",
    clientId: "historical-consent",
    scopes: [],
  });
  await db
    .insert(oauthConsent)
    .values({ id: "consent", clientId: "consent", scopes: [] });
  await db.insert(oauthAccessToken).values([
    {
      id: "access",
      token: "access",
      clientId: "access",
      scopes: [],
      expiresAt: FUTURE,
    },
    {
      id: "expired-access",
      token: "expired-access",
      clientId: "expired-access",
      scopes: [],
      expiresAt: OLD,
    },
    {
      id: "boundary-access",
      token: "boundary-access",
      clientId: "boundary-access",
      scopes: [],
      expiresAt: NOW,
    },
  ]);
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
  expect((await sweep()).clientsDeleted).toBe(3);
  expect(await remaining()).toEqual([
    "access",
    "authorization",
    "consent",
    "historical-consent",
    "refresh",
  ]);
  expect((await db.select().from(agentRegistration)).length).toBe(0);
  expect((await db.select().from(oauthConsent)).length).toBe(2);
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
    createdAt: new Date(NOW.getTime() - retentionDays * DAY_IN_MS),
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

test("assigns existing and new client registration origins during migration", async () => {
  const migration = readFileSync(
    new URL(
      "../../../../drizzle/20261003124800_registration_retention/migration.sql",
      import.meta.url,
    ),
    "utf-8",
  );
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA registration_origin_test`);
    await tx.execute(sql`SET LOCAL search_path TO registration_origin_test`);
    await tx.execute(
      sql`CREATE TABLE oauth_client (client_id text PRIMARY KEY)`,
    );
    await tx.execute(sql`CREATE TABLE scheduler_jobs (
      id text PRIMARY KEY, task text, description text, schedule jsonb,
      enabled boolean, next_run_at timestamptz
    )`);
    await tx.execute(
      sql`INSERT INTO oauth_client (client_id) VALUES ('existing')`,
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        await tx.execute(sql.raw(statement));
      }
    }
    await tx.execute(sql`INSERT INTO oauth_client (client_id) VALUES ('new')`);
    expect(
      (
        await tx.execute(
          sql`SELECT client_id, registration_origin FROM oauth_client ORDER BY client_id`,
        )
      ).rows,
    ).toEqual([
      { client_id: "existing", registration_origin: "historical" },
      { client_id: "new", registration_origin: "open-client" },
    ]);
    await tx.execute(sql`DROP SCHEMA registration_origin_test CASCADE`);
  });
});

test("retains assertion identifiers through the accepted clock interval", async () => {
  const expiry = new Date(
    NOW.getTime() - (AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS * 1000) / 2,
  );
  await db
    .insert(agentAssertionReplay)
    .values({ jti: "interval", expiresAt: expiry });
  expect((await sweep()).replaysDeleted).toBe(0);
  const repeated = await db
    .insert(agentAssertionReplay)
    .values({ jti: "interval", expiresAt: expiry })
    .onConflictDoNothing()
    .returning({ jti: agentAssertionReplay.jti });
  expect(repeated).toEqual([]);
  expect(await db.select().from(agentAssertionReplay)).toHaveLength(1);
});

test("expires unused clients created with the database origin default", async () => {
  await db.insert(oauthClient).values({
    id: "default-origin",
    clientId: "default-origin",
    redirectUris: [],
    createdAt: OLD,
    updatedAt: OLD,
  });
  expect((await sweep()).clientsDeleted).toBe(1);
  expect(await remaining()).toEqual([]);
});
