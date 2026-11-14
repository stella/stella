import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  oauthClient,
  oauthConsent,
  organization,
  session,
  user,
} from "@/api/db/auth-schema";
import { mcpWebHandoff } from "@/api/db/schema/mcp-web-handoff";
import {
  REGISTRATION_RETENTION_BATCH_SIZE,
  sweepRegistrations,
} from "@/api/lib/scheduler/tasks/registration-retention";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const now = new Date("2026-01-01T00:00:00Z");

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(user).values({
    id: "handoff-user",
    name: "Account",
    email: "handoff@example.test",
  });
  await db.insert(organization).values({
    id: "handoff-org",
    name: "Organization",
    slug: "handoff-org",
    createdAt: now,
  });
  await db.insert(oauthClient).values({
    id: "handoff-client",
    clientId: "handoff-client",
    redirectUris: [],
  });
  await db.insert(oauthConsent).values({
    id: "handoff-consent",
    clientId: "handoff-client",
    userId: "handoff-user",
    referenceId: "handoff-org",
    scopes: [],
  });
});
afterAll(async () => await client.close());

const row = (id: string) => ({
  id,
  codeHash: id.padStart(64, "0"),
  userId: "handoff-user",
  organizationId: "handoff-org",
  oauthClientId: "handoff-client",
  consentId: "handoff-consent",
  allowedPaths: ["/matters/example"],
  kind: "text" as const,
  expiresAt: new Date(now.getTime() - 1),
});

test("expired handoff retention is bounded and preserves live receipts", async () => {
  const expired = Array.from(
    { length: REGISTRATION_RETENTION_BATCH_SIZE + 1 },
    (_, i) => row(i.toString(16)),
  );
  await db
    .insert(mcpWebHandoff)
    .values([
      ...expired,
      { ...row("ffff"), expiresAt: new Date(now.getTime() + 1) },
    ]);
  const first = await sweep();
  expect(first.handoffsDeleted).toBe(REGISTRATION_RETENTION_BATCH_SIZE);
  expect(first.hasMore).toBe(true);
  const second = await sweep();
  expect(second.handoffsDeleted).toBe(1);
  expect((await db.select().from(mcpWebHandoff)).map(({ id }) => id)).toEqual([
    "ffff",
  ]);
});

test("consent deletion removes pending handoffs and their browser sessions", async () => {
  await db.insert(mcpWebHandoff).values(row("eeee"));
  await db.insert(session).values({
    id: "handoff-session",
    token: "handoff-session-token",
    userId: "handoff-user",
    originConsentId: "handoff-consent",
    handoffAbsoluteExpiresAt: now,
    expiresAt: now,
    updatedAt: now,
  });
  await db.delete(oauthConsent).where(eq(oauthConsent.id, "handoff-consent"));
  expect(await db.select().from(mcpWebHandoff)).toEqual([]);
  expect(
    await db.select().from(session).where(eq(session.id, "handoff-session")),
  ).toEqual([]);
});

const sweep = async () =>
  await sweepRegistrations({
    db: asTestRaw<SchedulerDb>({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        await db.transaction(
          async (tx) =>
            await callback({
              execute: async (query: SQL) => (await tx.execute(query)).rows,
            }),
        ),
    }),
    now,
    retentionDays: 7,
  });
