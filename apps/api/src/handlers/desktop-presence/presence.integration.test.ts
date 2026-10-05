import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import Elysia from "elysia";
import * as v from "valibot";

import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";
import {
  DESKTOP_PRESENCE_POLICY,
  desktopPresenceSchema,
} from "@stll/api-contract/desktop-presence";

import type { ScopedDb } from "@/api/db/safe-db";
import { desktopPresence } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import readEndpoint from "./read";
import { createDesktopPresenceReportEndpoint } from "./report";
import { readDesktopPresence, reportDesktopPresence } from "./service";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
let scopedDb: ScopedDb;
const desktopId = "11111111-1111-4111-8111-111111111111";
const anotherDesktopId = "22222222-2222-4222-8222-222222222222";
const report = {
  desktopId,
  version: "0.9.48",
  protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
};

beforeAll(
  async () => {
    fixture = await getRlsFixture();
    const { testDb, ids } = fixture;
    scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [], ids.orgA, ids.userA1),
    );
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

test("authenticated reports converge on one row and use the server clock", async () => {
  const { testDb, ids } = fixture;
  const endpoint = createDesktopPresenceReportEndpoint({
    authorizeAccount: async () =>
      Result.ok({
        scopedDb,
        userId: ids.userA1,
        organizationId: ids.orgA,
        keyId: "test-only",
      }),
  });
  const app = new Elysia().post("/v1/desktop/presence", endpoint.handler, {
    body: endpoint.config.body,
  });
  const before = Date.now();
  for (const version of ["0.9.47", report.version]) {
    const response = await app.handle(
      new Request("http://localhost/v1/desktop/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...report, version }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reported: true });
  }
  const rows = await testDb
    .select()
    .from(desktopPresence)
    .where(eq(desktopPresence.userId, ids.userA1));
  expect(rows).toHaveLength(1);
  expect(rows.at(0)).toMatchObject({
    ...report,
    userId: ids.userA1,
    organizationId: ids.orgA,
  });
  expect(rows.at(0)?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(rows.at(0)?.lastSeenAt.getTime()).toBeLessThanOrEqual(Date.now());
});

test("the signed-in read returns only the fixed presence projection", async () => {
  const { ids } = fixture;
  await reportDesktopPresence({
    scopedDb,
    userId: ids.userA1,
    organizationId: ids.orgA,
    report,
  });
  const reply = await readEndpoint.handler(
    createTestHandlerContext<Parameters<typeof readEndpoint.handler>[0]>({
      scopedDb,
      user: { id: ids.userA1 },
      session: { activeOrganizationId: ids.orgA },
    }),
  );
  expect(v.safeParse(desktopPresenceSchema, reply).success).toBe(true);
  expect(reply).toMatchObject({
    type: "current",
    desktop: { version: report.version, protocol: report.protocol },
  });
  expect(Object.keys(reply).toSorted()).toEqual(["desktop", "type"]);
});

test("app-role presence access is confined to the owner for reads, inserts, and updates", async () => {
  const { testDb, ids } = fixture;
  await reportDesktopPresence({
    scopedDb,
    userId: ids.userA1,
    organizationId: ids.orgA,
    report,
  });
  await testDb.insert(desktopPresence).values({
    userId: ids.userA2,
    organizationId: ids.orgA,
    desktopId,
    version: "0.9.43",
    protocol: 0,
  });
  const otherScoped = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [], ids.orgA, ids.userA2),
  );
  await reportDesktopPresence({
    scopedDb: otherScoped,
    userId: ids.userA2,
    organizationId: ids.orgA,
    report: { ...report, protocol: 0 },
  });
  const ownRows = await scopedDb((tx) => tx.select().from(desktopPresence));
  expect(ownRows.length).toBeGreaterThan(0);
  expect(ownRows.every((row) => row.userId === ids.userA1)).toBe(true);
  const changed = await scopedDb((tx) =>
    tx
      .update(desktopPresence)
      .set({ version: "0.9.99" })
      .where(eq(desktopPresence.userId, ids.userA2))
      .returning(),
  );
  expect(changed).toEqual([]);
  const deniedInsert = await Result.tryPromise(
    async () =>
      await reportDesktopPresence({
        scopedDb,
        userId: ids.userA2,
        organizationId: ids.orgA,
        report: { ...report, desktopId: anotherDesktopId },
      }),
  );
  expect(deniedInsert).toMatchObject({
    error: { cause: { cause: { code: "42501" } } },
  });
  const deniedReassignment = await Result.tryPromise(
    async () =>
      await scopedDb((tx) =>
        tx
          .update(desktopPresence)
          .set({ userId: ids.userA2, organizationId: ids.orgA })
          .where(eq(desktopPresence.userId, ids.userA1)),
      ),
  );
  expect(deniedReassignment).toMatchObject({
    error: { cause: { cause: { code: "42501" } } },
  });
  const deniedOrganization = await Result.tryPromise(
    async () =>
      await reportDesktopPresence({
        scopedDb,
        userId: ids.userA1,
        organizationId: ids.orgB,
        report,
      }),
  );
  expect(deniedOrganization).toMatchObject({
    error: { cause: { cause: { code: "42501" } } },
  });
  await testDb
    .insert(desktopPresence)
    .values({ userId: ids.userA1, organizationId: ids.orgB, ...report });
  expect(
    await readDesktopPresence({
      scopedDb,
      userId: ids.userA1,
      organizationId: ids.orgB,
    }),
  ).toEqual({ type: "none" });
  const deniedOrganizationMove = await Result.tryPromise(
    async () =>
      await scopedDb((tx) =>
        tx
          .update(desktopPresence)
          .set({ organizationId: ids.orgB })
          .where(eq(desktopPresence.userId, ids.userA1)),
      ),
  );
  expect(deniedOrganizationMove).toMatchObject({
    error: { cause: { cause: { code: "42501" } } },
  });
  expect(
    await readDesktopPresence({
      scopedDb,
      userId: ids.userA2,
      organizationId: ids.orgA,
    }),
  ).toEqual({
    type: "none",
  });
});

test("presence read prefers a fresh supported desktop over newer outdated reports", async () => {
  const { testDb, ids } = fixture;
  const now = new Date("2026-10-05T08:00:00.000Z");
  await testDb
    .delete(desktopPresence)
    .where(eq(desktopPresence.userId, ids.userA1));
  const observations = [
    {
      desktopId,
      protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
      lastSeenAt: new Date(now.getTime() - 1000),
    },
    {
      desktopId: anotherDesktopId,
      protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL - 1,
      lastSeenAt: now,
    },
  ];
  await testDb.insert(desktopPresence).values(
    observations.map((row) => ({
      ...row,
      userId: ids.userA1,
      organizationId: ids.orgA,
      version: report.version,
    })),
  );
  expect(
    await readDesktopPresence({
      scopedDb,
      userId: ids.userA1,
      organizationId: ids.orgA,
      now,
    }),
  ).toMatchObject({ type: "current", desktop: { protocol: report.protocol } });
  await testDb
    .delete(desktopPresence)
    .where(
      and(
        eq(desktopPresence.desktopId, desktopId),
        eq(desktopPresence.userId, ids.userA1),
      ),
    );
  expect(
    await readDesktopPresence({
      scopedDb,
      userId: ids.userA1,
      organizationId: ids.orgA,
      now,
    }),
  ).toMatchObject({
    type: "outdated",
    desktop: { protocol: report.protocol - 1 },
  });
  const stale = new Date(
    now.getTime() - DESKTOP_PRESENCE_POLICY.freshnessSeconds * 1000 - 1,
  );
  await testDb
    .update(desktopPresence)
    .set({ lastSeenAt: stale })
    .where(eq(desktopPresence.userId, ids.userA1));
  expect(
    await readDesktopPresence({
      scopedDb,
      userId: ids.userA1,
      organizationId: ids.orgA,
      now,
    }),
  ).toMatchObject({
    type: "not_connected",
    desktop: { lastSeenAt: stale.toISOString() },
  });
  await testDb
    .delete(desktopPresence)
    .where(eq(desktopPresence.userId, ids.userA1));
  expect(
    await readDesktopPresence({
      scopedDb,
      userId: ids.userA1,
      organizationId: ids.orgA,
      now,
    }),
  ).toEqual({ type: "none" });
});

test("the committed presence table forces row security with owner-only policies", async () => {
  const rows = await fixture.testDb.execute<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(sql`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'desktop_presence'::regclass
  `);
  expect(rows.rows).toEqual([
    { relrowsecurity: true, relforcerowsecurity: true },
  ]);
});
