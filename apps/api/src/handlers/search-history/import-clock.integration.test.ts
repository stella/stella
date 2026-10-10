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
import { and, eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  searchHistoryEntries,
  searchHistoryOwners,
  searchHistoryTombstones,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import clear from "./clear";
import deleteEntry from "./delete";
import importEntries from "./import";
import importClock from "./import-clock";
import list from "./list";
import record from "./upsert";

const DEVICE_CLOCK_AHEAD_MS = 60 * 60 * 1000;
const INITIAL_MEMBERSHIP_CREATED_AT = new Date("2000-01-01T00:00:00.000Z");
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = (await getRlsFixture()).testDb;
});
afterEach(() => setSystemTime());
afterAll(async () => {
  await releaseRlsFixture();
});

type HistoryFixture = {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const withHistory = async (
  work: (fixture: HistoryFixture) => Promise<void>,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await testDb.insert(user).values({
    id: userId,
    name: "History member",
    email: `${userId}@example.test`,
  });
  try {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "History organization",
      slug: organizationId,
      createdAt: new Date(),
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(INITIAL_MEMBERSHIP_CREATED_AT),
    });
    await work({ db: testDb, organizationId, userId });
  } finally {
    await testDb
      .delete(organization)
      .where(eq(organization.id, organizationId));
    await testDb.delete(user).where(eq(user.id, userId));
  }
};

const identity = (fixture: HistoryFixture) => ({
  query: {
    expectedOrganizationId: fixture.organizationId,
    expectedUserId: fixture.userId,
  },
  audit: createBackgroundAuditRecorder({
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    workspaceId: null,
    execution: {
      performer: { type: "user", id: fixture.userId },
      trigger: { type: "direct" },
    },
  }),
  scopedDb: NO_DB,
  safeDb: createSafeDb(fixture.db, [], fixture.organizationId, fixture.userId),
  session: { activeOrganizationId: fixture.organizationId },
  user: { id: fixture.userId },
});

const acquireClock = async (fixture: HistoryFixture) => {
  const result = await importClock.handler(
    createTestHandlerContext<Parameters<typeof importClock.handler>[0]>(
      identity(fixture),
    ),
  );
  if (result instanceof ElysiaCustomStatusResponse) {
    return panic(
      `Expected import clock success, received status ${result.code}`,
    );
  }
  return result;
};

const acquireClockAfter = async (fixture: HistoryFixture, cutoff: Date) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const clock = await acquireClock(fixture);
    if (Date.parse(clock.issuedAt) > cutoff.getTime()) {
      return clock;
    }
    // Both clocks must differ despite the issued clock's millisecond rounding.
    await Bun.sleep(1);
  }
  return panic("Expected an import clock strictly after the database cutoff");
};

const readHistory = async (fixture: HistoryFixture) => {
  const result = await list.handler(
    createTestHandlerContext<Parameters<typeof list.handler>[0]>({
      ...identity(fixture),
    }),
  );
  if (result instanceof ElysiaCustomStatusResponse) {
    return panic(`Expected history success, received status ${result.code}`);
  }
  return result;
};

const recordQuery = async (fixture: HistoryFixture, query: string) => {
  const result = await record.handler(
    createTestHandlerContext<Parameters<typeof record.handler>[0]>({
      ...identity(fixture),
      body: { kind: "search", query },
    }),
  );
  if (result instanceof ElysiaCustomStatusResponse) {
    return panic(`Expected record success, received status ${result.code}`);
  }
  return result;
};

const clearHistoryCutoff = async (fixture: HistoryFixture) => {
  await clear.handler(
    createTestHandlerContext<Parameters<typeof clear.handler>[0]>(
      identity(fixture),
    ),
  );
  const owner = (
    await fixture.db
      .select({ clearedAt: searchHistoryOwners.clearedAt })
      .from(searchHistoryOwners)
      .where(
        and(
          eq(searchHistoryOwners.organizationId, fixture.organizationId),
          eq(searchHistoryOwners.userId, fixture.userId),
        ),
      )
  ).at(0);
  if (!owner?.clearedAt) {
    return panic("Expected the search history clear cutoff");
  }
  return owner.clearedAt;
};

const deleteHistoryCutoff = async (fixture: HistoryFixture, query: string) => {
  const original = await recordQuery(fixture, query);
  await deleteEntry.handler(
    createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>({
      ...identity(fixture),
      params: { entryId: original.id },
    }),
  );
  const tombstone = (
    await fixture.db
      .select({ deletedAt: searchHistoryTombstones.deletedAt })
      .from(searchHistoryTombstones)
      .where(
        and(
          eq(searchHistoryTombstones.organizationId, fixture.organizationId),
          eq(searchHistoryTombstones.userId, fixture.userId),
        ),
      )
  ).at(0);
  return (
    tombstone?.deletedAt ?? panic("Expected the search history deletion cutoff")
  );
};

const expectNoImportWrites = async (fixture: HistoryFixture) => {
  for (const table of [
    searchHistoryEntries,
    searchHistoryOwners,
    searchHistoryTombstones,
    auditLogs,
  ]) {
    expect(
      await fixture.db.$count(
        table,
        eq(table.organizationId, fixture.organizationId),
      ),
    ).toBe(0);
  }
};

describe("search history import clock integration", () => {
  test("clear prevents a pre-clear use from an ahead-clock device from restoring history", async () => {
    await withHistory(async (fixture) => {
      const query = "Earlier local query";
      await recordQuery(fixture, query);
      const cutoff = await clearHistoryCutoff(fixture);
      const clock = await acquireClock(fixture);
      const serverNow = new Date(
        Math.max(
          cutoff.getTime() + 10_000,
          Date.parse(clock.issuedAt) + 10_000,
        ),
      );
      const clientNow = new Date(serverNow.getTime() + DEVICE_CLOCK_AHEAD_MS);
      const localUsedAt = new Date(
        cutoff.getTime() - 1000 + DEVICE_CLOCK_AHEAD_MS,
      );
      expect(localUsedAt.getTime()).toBeGreaterThan(serverNow.getTime());
      setSystemTime(serverNow);

      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query },
                usedAt: localUsedAt.toISOString(),
              },
            ],
          },
        }),
      );

      expect(imported).toEqual({ entries: 0, skipped: 1, rejected: 0 });
      expect((await readHistory(fixture)).items).toEqual([]);
    });
  });

  test("delete prevents a pre-delete use from an ahead-clock device from restoring history", async () => {
    await withHistory(async (fixture) => {
      const query = "Earlier deleted query";
      const original = await recordQuery(fixture, query);
      await deleteEntry.handler(
        createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>({
          ...identity(fixture),
          params: { entryId: original.id },
        }),
      );
      const tombstone = (
        await fixture.db
          .select({ deletedAt: searchHistoryTombstones.deletedAt })
          .from(searchHistoryTombstones)
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
            ),
          )
      ).at(0);
      if (!tombstone) {
        panic("Expected the search history deletion cutoff");
      }
      const cutoff = tombstone.deletedAt;
      const clock = await acquireClock(fixture);
      const serverNow = new Date(
        Math.max(
          cutoff.getTime() + 10_000,
          Date.parse(clock.issuedAt) + 10_000,
        ),
      );
      const clientNow = new Date(serverNow.getTime() + DEVICE_CLOCK_AHEAD_MS);
      const localUsedAt = new Date(
        cutoff.getTime() - 1000 + DEVICE_CLOCK_AHEAD_MS,
      );
      expect(localUsedAt.getTime()).toBeGreaterThan(serverNow.getTime());
      setSystemTime(serverNow);

      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query },
                usedAt: localUsedAt.toISOString(),
              },
            ],
          },
        }),
      );

      expect(imported).toEqual({ entries: 0, skipped: 1, rejected: 0 });
      expect((await readHistory(fixture)).items).toEqual([]);
    });
  });

  test("keeps a post-clear use from an ahead-clock device with its corrected timestamp", async () => {
    await withHistory(async (fixture) => {
      const cutoff = await clearHistoryCutoff(fixture);
      const clock = await acquireClockAfter(fixture, cutoff);
      const anchorMs = Date.parse(clock.issuedAt);
      const serverNow = new Date(anchorMs + 500);
      const clientNow = new Date(anchorMs + DEVICE_CLOCK_AHEAD_MS);
      const correctedUsedAt = new Date(anchorMs);
      const localUsedAt = clientNow;
      expect(localUsedAt.getTime()).toBeGreaterThan(serverNow.getTime());
      setSystemTime(serverNow);

      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query: "Later local query" },
                usedAt: localUsedAt.toISOString(),
              },
            ],
          },
        }),
      );

      expect(imported).toEqual({ entries: 1, skipped: 0, rejected: 0 });
      expect((await readHistory(fixture)).items).toMatchObject([
        {
          query: "Later local query",
          useCount: 1,
          firstUsedAt: correctedUsedAt.toISOString(),
          lastUsedAt: correctedUsedAt.toISOString(),
        },
      ]);
    });
  });

  test("rejects a local use that remains in the future after clock correction", async () => {
    await withHistory(async (fixture) => {
      const cutoff = await clearHistoryCutoff(fixture);
      const clock = await acquireClock(fixture);
      const serverNow = new Date(
        Math.max(
          cutoff.getTime() + 10_000,
          Date.parse(clock.issuedAt) + 10_000,
        ),
      );
      const clientNow = new Date(serverNow.getTime() + DEVICE_CLOCK_AHEAD_MS);
      const localUsedAt = new Date(clientNow.getTime() + 1000);
      expect(localUsedAt.getTime()).toBeGreaterThan(clientNow.getTime());
      setSystemTime(serverNow);

      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query: "Future local query" },
                usedAt: localUsedAt.toISOString(),
              },
            ],
          },
        }),
      );

      expect(imported).toEqual({ entries: 0, skipped: 1, rejected: 1 });
      expect((await readHistory(fixture)).items).toEqual([]);
    });
  });

  for (const barrier of ["clear", "delete"] as const) {
    for (const transitMs of [500, 90_000]) {
      test(`${barrier} prevents a delayed import from restoring an earlier use after ${transitMs} milliseconds`, async () => {
        await withHistory(async (fixture) => {
          const query = "Earlier delayed query";
          const cutoff =
            barrier === "clear"
              ? await clearHistoryCutoff(fixture)
              : await deleteHistoryCutoff(fixture, query);
          const clock = await acquireClock(fixture);
          const clientNow = new Date(
            Math.max(Date.parse(clock.issuedAt), cutoff.getTime()) + 100,
          );
          const usedAt = new Date(cutoff.getTime() - 100);
          const serverNow = new Date(clientNow.getTime() + transitMs);
          const unboundedUsedAt = new Date(usedAt.getTime() + transitMs);
          expect(unboundedUsedAt.getTime()).toBeGreaterThan(cutoff.getTime());
          expect(clientNow.getTime()).toBeGreaterThan(
            Date.parse(clock.issuedAt),
          );
          setSystemTime(serverNow);
          const imported = await importEntries.handler(
            createTestHandlerContext<
              Parameters<typeof importEntries.handler>[0]
            >({
              ...identity(fixture),
              body: {
                clock,
                clientNow: clientNow.toISOString(),
                entries: [
                  {
                    entry: { kind: "search", query },
                    usedAt: usedAt.toISOString(),
                  },
                ],
              },
            }),
          );
          expect(imported).toEqual({ entries: 0, skipped: 1, rejected: 0 });
          expect((await readHistory(fixture)).items).toEqual([]);
        });
      });
    }
  }

  test("skips an ambiguous post-clear use when its clock interval overlaps the cutoff", async () => {
    await withHistory(async (fixture) => {
      const cutoff = await clearHistoryCutoff(fixture);
      const clock = await acquireClock(fixture);
      const clientNow = new Date(
        Math.max(Date.parse(clock.issuedAt), cutoff.getTime()) + 300,
      );
      const usedAt = new Date(cutoff.getTime() + 100);
      const serverNow = new Date(clientNow.getTime() + 500);
      const lowerMs =
        usedAt.getTime() + Date.parse(clock.issuedAt) - clientNow.getTime();
      expect(usedAt.getTime()).toBeGreaterThan(cutoff.getTime());
      expect(lowerMs).toBeLessThanOrEqual(cutoff.getTime());
      setSystemTime(serverNow);
      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query: "Recent ambiguous query" },
                usedAt: usedAt.toISOString(),
              },
            ],
          },
        }),
      );
      expect(imported).toEqual({ entries: 0, skipped: 1, rejected: 0 });
      expect((await readHistory(fixture)).items).toEqual([]);
    });
  });

  test("keeps a clearly post-clear use despite more than seventy-five seconds of transit", async () => {
    await withHistory(async (fixture) => {
      const cutoff = await clearHistoryCutoff(fixture);
      const clock = await acquireClockAfter(fixture, cutoff);
      const clientNow = new Date(Date.parse(clock.issuedAt) + 100);
      const serverNow = new Date(clientNow.getTime() + 90_000);
      setSystemTime(serverNow);
      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query: "Later delayed query" },
                usedAt: clientNow.toISOString(),
              },
            ],
          },
        }),
      );
      expect(imported).toEqual({ entries: 1, skipped: 0, rejected: 0 });
      expect((await readHistory(fixture)).items).toMatchObject([
        {
          query: "Later delayed query",
          useCount: 1,
          firstUsedAt: clock.issuedAt,
          lastUsedAt: clock.issuedAt,
        },
      ]);
    });
  });

  test("a delayed earlier import preserves a newer equivalent spelling and its ordering", async () => {
    await withHistory(async (fixture) => {
      const clock = await acquireClock(fixture);
      const anchorMs = Date.parse(clock.issuedAt);
      const clientNow = new Date(anchorMs + 100);
      const usedAt = new Date(clientNow.getTime() - 50);
      const newerUsedAt = new Date(anchorMs + 200);
      const serverNow = new Date(clientNow.getTime() + 500);
      const unboundedUsedAt = new Date(usedAt.getTime() + 500);
      expect(unboundedUsedAt.getTime()).toBeGreaterThan(newerUsedAt.getTime());
      setSystemTime(newerUsedAt);
      const newer = await recordQuery(fixture, "NÁHRADA škody");
      setSystemTime(new Date(anchorMs + 250));
      const other = await recordQuery(fixture, "Other recent query");
      setSystemTime(serverNow);

      const imported = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: clientNow.toISOString(),
            entries: [
              {
                entry: { kind: "search", query: "náhrada škody" },
                usedAt: usedAt.toISOString(),
              },
            ],
          },
        }),
      );

      expect(imported).toEqual({ entries: 1, skipped: 0, rejected: 0 });
      expect((await readHistory(fixture)).items).toMatchObject([
        { id: other.id, query: "Other recent query" },
        {
          id: newer.id,
          query: "NÁHRADA škody",
          firstUsedAt: new Date(anchorMs - 50).toISOString(),
          lastUsedAt: newerUsedAt.toISOString(),
        },
      ]);
    });
  });

  test("rejects a modified import clock signature without writing history", async () => {
    await withHistory(async (fixture) => {
      const authentic = await acquireClock(fixture);
      const signature = `${authentic.signature.startsWith("0") ? "1" : "0"}${authentic.signature.slice(1)}`;
      const response = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock: { issuedAt: authentic.issuedAt, signature },
            clientNow: new Date().toISOString(),
            entries: [
              {
                entry: { kind: "search", query: "Signed clock query" },
                usedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      );
      expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
      if (response instanceof ElysiaCustomStatusResponse) {
        expect(response.code).toBe(400);
      }
      await expectNoImportWrites(fixture);
    });
  });

  for (const direction of [-1, 1]) {
    test(`rejects the whole import when the device clock is more than one day ${direction === 1 ? "ahead" : "behind"}`, async () => {
      await withHistory(async (fixture) => {
        const clock = await acquireClock(fixture);
        const serverNow = new Date();
        setSystemTime(serverNow);
        const clientNow = new Date(
          serverNow.getTime() +
            direction * (LIMITS.searchHistoryClockSkewMaxMs + 1),
        );
        const response = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                clock,
                clientNow: clientNow.toISOString(),
                entries: [
                  {
                    entry: { kind: "search", query: "Local clock query" },
                    usedAt: new Date(clientNow.getTime() - 1000).toISOString(),
                  },
                ],
              },
            },
          ),
        );
        expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
        if (response instanceof ElysiaCustomStatusResponse) {
          expect(response.code).toBe(400);
        }
        await expectNoImportWrites(fixture);
      });
    });
  }

  test("rejects the whole import when the device clock is malformed", async () => {
    await withHistory(async (fixture) => {
      const clock = await acquireClock(fixture);
      const response = await importEntries.handler(
        createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>({
          ...identity(fixture),
          body: {
            clock,
            clientNow: "invalid",
            entries: [
              {
                entry: { kind: "search", query: "Local clock query" },
                usedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      );
      expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
      if (response instanceof ElysiaCustomStatusResponse) {
        expect(response.code).toBe(400);
      }
      await expectNoImportWrites(fixture);
    });
  });
});
