import { panic } from "better-result";
import type { SQL } from "bun";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { sha256Hex } from "@stll/sha256/bun";
import { normalizeUnicode } from "@stll/text-normalize";

import { member, organization, user } from "@/api/db/auth-schema";
import type { OnlineMigrationConnection } from "@/api/db/online-migration-connection";
import {
  auditLogs,
  searchHistoryCountryClears,
  searchHistoryEntries,
  searchHistoryOwners,
  searchHistoryTombstones,
} from "@/api/db/schema";
import type { RlsDatabaseMarker } from "@/api/db/scoped";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import { deleteSearchHistory } from "@/api/lib/account-deletion-steps";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { keyedContentLookupKey } from "@/api/lib/content-encryption";
import { LIMITS } from "@/api/lib/limits";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import { createUngatedTableGateForTests } from "../../db/online-ddl";
import { createSearchHistoryCountryRepair } from "../../db/search-history-country-repair";
import clear from "./clear";
import deleteEntry from "./delete";
import {
  prepareSearchHistoryImportRows,
  prepareSearchHistoryRows,
  upsertSearchHistoryRows,
} from "./entries";
import importEntries from "./import";
import importClock from "./import-clock";
import list from "./list";
import record from "./upsert";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const NOW = new Date();
const INITIAL_MEMBERSHIP_CREATED_AT = new Date("2000-01-01T00:00:00.000Z");

type HistoryFixture = {
  sql: SQL;
  db: GatedTestDb;
  rlsDb: GatedTestDb & RlsDatabaseMarker;
  organizationId: SafeId<"organization">;
  otherOrganizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  otherUserId: SafeId<"user">;
  ownerId: SafeId<"user">;
  memberId: string;
};

const withHistory = async (
  connectionUrl: string,
  work: (fixture: HistoryFixture) => Promise<void>,
) => {
  await withGatedTestClients(connectionUrl, async ({ openClient }) => {
    const { db, sql: client } = openClient({ max: 4 });
    const organizationId = mintAuthProviderId<"organization">();
    const otherOrganizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const otherUserId = mintAuthProviderId<"user">();
    const ownerId = mintAuthProviderId<"user">();
    const memberId = Bun.randomUUIDv7();
    const organizationIds = [organizationId, otherOrganizationId];
    const userIds = [userId, otherUserId, ownerId];
    await db.insert(user).values(
      userIds.map((id) => ({
        id,
        name: "History member",
        email: `${id}@example.test`,
      })),
    );
    try {
      await db.insert(organization).values(
        organizationIds.map((id) => ({
          id,
          name: "History organization",
          slug: id,
          createdAt: new Date(),
        })),
      );
      for (const id of organizationIds) {
        await recordNewOrganizationAccessState(db, {
          organizationId: id,
          now: new Date(),
        });
      }
      await db.insert(member).values([
        {
          id: memberId,
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(INITIAL_MEMBERSHIP_CREATED_AT),
        },
        {
          id: Bun.randomUUIDv7(),
          organizationId,
          userId: otherUserId,
          role: "member",
          createdAt: new Date(INITIAL_MEMBERSHIP_CREATED_AT),
        },
        {
          id: Bun.randomUUIDv7(),
          organizationId,
          userId: ownerId,
          role: "owner",
          createdAt: new Date(INITIAL_MEMBERSHIP_CREATED_AT),
        },
        {
          id: Bun.randomUUIDv7(),
          organizationId: otherOrganizationId,
          userId,
          role: "owner",
          createdAt: new Date(INITIAL_MEMBERSHIP_CREATED_AT),
        },
      ]);
      const rlsDb = markRlsDatabase(db);
      await work({
        sql: client,
        db,
        rlsDb,
        organizationId,
        otherOrganizationId,
        userId,
        otherUserId,
        ownerId,
        memberId,
      });
    } finally {
      await db
        .delete(organization)
        .where(inArray(organization.id, organizationIds));
      await db.delete(user).where(inArray(user.id, userIds));
    }
  });
};

const historyAuditRecorder = (fixture: HistoryFixture) =>
  createBackgroundAuditRecorder({
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    workspaceId: null,
    execution: {
      performer: { type: "user", id: fixture.userId },
      trigger: { type: "direct" },
    },
  });

const identity = (fixture: HistoryFixture) => ({
  query: {
    expectedOrganizationId: fixture.organizationId,
    expectedUserId: fixture.userId,
  },
  audit: historyAuditRecorder(fixture),
  scopedDb: NO_DB,
  safeDb: createSafeDb(
    fixture.rlsDb,
    [],
    fixture.organizationId,
    fixture.userId,
  ),
  session: { activeOrganizationId: fixture.organizationId },
  user: { id: fixture.userId },
});

const getImportClockBody = async (fixture: HistoryFixture) => {
  const result = await importClock.handler(
    createTestHandlerContext<Parameters<typeof importClock.handler>[0]>(
      identity(fixture),
    ),
  );
  if (result instanceof HttpStatusResponse) {
    return panic(
      `Expected import clock success, received status ${result.code}`,
    );
  }
  return { clock: result, clientNow: result.issuedAt };
};

const readHistory = async (
  fixture: HistoryFixture,
  query: Parameters<typeof list.handler>[0]["query"] = {},
) => {
  const result = await list.handler(
    createTestHandlerContext<Parameters<typeof list.handler>[0]>({
      ...identity(fixture),
      query,
    }),
  );
  if (result instanceof HttpStatusResponse) {
    return panic(`Expected history success, received status ${result.code}`);
  }
  return result;
};

const recordEntry = async (
  fixture: HistoryFixture,
  body: Parameters<typeof record.handler>[0]["body"],
) => {
  const result = await record.handler(
    createTestHandlerContext<Parameters<typeof record.handler>[0]>({
      ...identity(fixture),
      body,
    }),
  );
  if (result instanceof HttpStatusResponse) {
    return panic(`Expected record success, received status ${result.code}`);
  }
  return result;
};

const recordQuery = async (
  fixture: HistoryFixture,
  query: string,
  country: CaseLawJurisdiction = "CZE",
) => await recordEntry(fixture, { kind: "search", query, country });

if (!databaseUrl || !enabled) {
  describe.skip("search history (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("search history (postgres)", () => {
    beforeEach(() => setSystemTime(NOW));
    afterEach(() => setSystemTime());

    test("base identity writes retain one row across country metadata versions", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "Náhrada škody";
        const baseKey = (
          await keyedContentLookupKey(
            fixture.organizationId,
            `search\u0000náhrada škody`,
          )
        ).unwrap();
        const written = await recordQuery(fixture, query, "CZE");
        const stored = (
          await fixture.db
            .select()
            .from(searchHistoryEntries)
            .where(eq(searchHistoryEntries.id, written.id))
        ).at(0);
        expect(stored).toMatchObject({
          lookupKey: baseKey,
          baseLookupKey: baseKey,
          country: "CZE",
        });
        const oldRows = await prepareSearchHistoryRows(fixture, [
          {
            entry: { kind: "search", query, country: "CZE" },
            usedAt: new Date(),
          },
        ]);
        const oldRow = oldRows.at(0);
        if (oldRow === undefined) {
          panic("Expected one prepared history use");
        }
        const { baseLookupKey: _metadata, ...oldWriterRow } = {
          ...oldRow,
          baseLookupKey: baseKey,
        };
        await fixture.db
          .insert(searchHistoryEntries)
          .values(oldWriterRow)
          .onConflictDoUpdate({
            target: [
              searchHistoryEntries.organizationId,
              searchHistoryEntries.userId,
              searchHistoryEntries.kind,
              searchHistoryEntries.lookupKey,
            ],
            set: {
              useCount: sql`${searchHistoryEntries.useCount} + excluded.use_count`,
            },
          });
        const listed = await readHistory(fixture, { country: "CZE" });
        expect(listed.items).toHaveLength(1);
        expect(listed.items.at(0)).toMatchObject({
          id: written.id,
          useCount: 2,
        });
        await fixture.db
          .update(searchHistoryEntries)
          .set({ baseLookupKey: null })
          .where(eq(searchHistoryEntries.id, written.id));
        const next = await recordQuery(fixture, query, "CZE");
        expect(next.id).toBe(written.id);
        const restored = (
          await fixture.db
            .select({
              baseLookupKey: searchHistoryEntries.baseLookupKey,
              useCount: searchHistoryEntries.useCount,
            })
            .from(searchHistoryEntries)
            .where(eq(searchHistoryEntries.id, written.id))
        ).at(0);
        expect(restored).toEqual({ baseLookupKey: baseKey, useCount: 3 });
      });
    });

    test("base and country-scoped read identities retain one current entry", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const original = await recordQuery(fixture, "Náhrada škody", "CZE");
        const row = (
          await fixture.db
            .select()
            .from(searchHistoryEntries)
            .where(eq(searchHistoryEntries.id, original.id))
        ).at(0);
        if (row === undefined) {
          panic("Expected stored history");
        }
        const scopedKey = sha256Hex(
          `search-history-country:v1\u0000CZE\u0000${row.lookupKey}`,
        );
        expect(scopedKey).not.toBe(row.lookupKey);
        await fixture.db.insert(searchHistoryEntries).values({
          ...row,
          id: createSafeId<"searchHistoryEntry">(),
          lookupKey: scopedKey,
          baseLookupKey: row.lookupKey,
          lastUsedAt: new Date(row.lastUsedAt.getTime() + 1000),
        });
        const otherCountryId = createSafeId<"searchHistoryEntry">();
        await fixture.db.insert(searchHistoryEntries).values({
          ...row,
          id: otherCountryId,
          country: "POL",
          lookupKey: sha256Hex(
            `search-history-country:v1\u0000POL\u0000${row.lookupKey}`,
          ),
          baseLookupKey: row.lookupKey,
        });
        const normalized = (await readHistory(fixture, { country: "CZE" }))
          .items;
        expect(normalized).toHaveLength(1);
        const visible = normalized.at(0);
        if (visible === undefined) {
          panic("Expected normalized history");
        }
        await deleteEntry.handler(
          createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>({
            ...identity(fixture),
            params: { entryId: visible.id },
          }),
        );
        const remaining = (await readHistory(fixture)).items;
        expect(remaining).toHaveLength(1);
        expect(remaining.at(0)).toMatchObject({
          id: otherCountryId,
          country: "POL",
        });
        const barriers = await fixture.db
          .select({ lookupKey: searchHistoryTombstones.lookupKey })
          .from(searchHistoryTombstones)
          .where(
            eq(searchHistoryTombstones.organizationId, fixture.organizationId),
          );
        expect(barriers).toEqual([{ lookupKey: row.lookupKey }]);
      });
    });

    test("country clear blocks its stale base identity and preserves another country import", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "Náhrada škody";
        await recordQuery(fixture, query, "CZE");
        const context = identity(fixture);
        expect(
          await clear.handler(
            createTestHandlerContext<Parameters<typeof clear.handler>[0]>({
              ...context,
              query: { ...context.query, country: "CZE" },
            }),
          ),
        ).toEqual({ deleted: 1 });
        const importCountry = async (country: CaseLawJurisdiction) =>
          await importEntries.handler(
            createTestHandlerContext<
              Parameters<typeof importEntries.handler>[0]
            >({
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query, country },
                    usedAt: "2020-01-02T03:04:05.000Z",
                  },
                ],
              },
            }),
          );
        expect(await importCountry("POL")).toEqual({
          entries: 1,
          skipped: 0,
          rejected: 0,
        });
        expect(await importCountry("CZE")).toEqual({
          entries: 0,
          skipped: 1,
          rejected: 0,
        });
        expect(
          (await readHistory(fixture, { country: "POL" })).items,
        ).toHaveLength(1);
        expect(
          (await readHistory(fixture, { country: "CZE" })).items,
        ).toHaveLength(0);
        const tombstones = await fixture.db
          .select()
          .from(searchHistoryTombstones)
          .where(
            eq(searchHistoryTombstones.organizationId, fixture.organizationId),
          );
        expect(tombstones).toHaveLength(0);
      });
    });

    test("country aggregates retain only that country's uses across a clear", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "Náhrada škody";
        await recordQuery(fixture, query, "CZE");
        await recordQuery(fixture, query, "CZE");
        await recordQuery(fixture, query, "POL");
        const polish = (
          await readHistory(fixture, { country: "POL" })
        ).items.at(0);
        const context = identity(fixture);
        await clear.handler(
          createTestHandlerContext<Parameters<typeof clear.handler>[0]>({
            ...context,
            query: { ...context.query, country: "CZE" },
          }),
        );
        await recordQuery(fixture, query, "POL");
        expect(
          (await readHistory(fixture, { country: "POL" })).items.at(0),
        ).toMatchObject({
          useCount: 2,
          firstUsedAt: polish?.firstUsedAt,
        });
        await recordQuery(fixture, query, "CZE");
        const czech = (await readHistory(fixture, { country: "CZE" })).items.at(
          0,
        );
        expect(czech?.useCount).toBe(1);
        expect(
          new Date(czech?.firstUsedAt ?? 0).getTime(),
        ).toBeGreaterThanOrEqual(new Date(polish?.lastUsedAt ?? 0).getTime());
      });
    });

    test("mixed country import aggregates stay on their own side of a clear", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const context = identity(fixture);
        await clear.handler(
          createTestHandlerContext<Parameters<typeof clear.handler>[0]>({
            ...context,
            query: { ...context.query, country: "CZE" },
          }),
        );
        const cutoff = (
          await fixture.db
            .select()
            .from(searchHistoryCountryClears)
            .where(
              eq(
                searchHistoryCountryClears.organizationId,
                fixture.organizationId,
              ),
            )
        ).at(0);
        if (cutoff === undefined) {
          panic("Expected country clear cutoff");
        }
        const before = new Date(cutoff.clearedAt.getTime() - 1000);
        const after = new Date(cutoff.clearedAt.getTime() + 1000);
        const rows = await prepareSearchHistoryImportRows(fixture, [
          {
            entry: { kind: "search", query: "Náhrada škody", country: "POL" },
            usedAt: before,
          },
          {
            entry: { kind: "search", query: "Náhrada škody", country: "CZE" },
            usedAt: after,
          },
        ]);
        await fixture.db.transaction(
          async (tx) =>
            await upsertSearchHistoryRows({
              tx,
              rows,
              mode: "import",
              timestampSource: "prepared",
              recordAuditEvent: historyAuditRecorder(fixture),
            }),
        );
        await fixture.db.transaction(
          async (tx) =>
            await upsertSearchHistoryRows({
              tx,
              rows: rows.slice(0, 1),
              mode: "import",
              timestampSource: "prepared",
              recordAuditEvent: historyAuditRecorder(fixture),
            }),
        );
        expect(
          (await readHistory(fixture, { country: "CZE" })).items.at(0),
        ).toMatchObject({
          firstUsedAt: after.toISOString(),
          lastUsedAt: after.toISOString(),
          useCount: 1,
        });
        expect(
          await fixture.db
            .select({ id: searchHistoryEntries.id })
            .from(searchHistoryEntries)
            .where(
              eq(searchHistoryEntries.organizationId, fixture.organizationId),
            ),
        ).toHaveLength(1);
      });
    });

    test("country clear retains unclassified documents until their bounded repair completes", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const saved = await recordEntry(fixture, {
          kind: "statute",
          documentId: "legacy-history-statute",
          title: "Zákon",
          path: "/law/cze/statutes/89-2012",
        });
        await fixture.db
          .update(searchHistoryEntries)
          .set({
            country: null,
            countryUsedAt: null,
            countryRepairFailedAt: new Date(),
          })
          .where(eq(searchHistoryEntries.id, saved.id));
        const context = identity(fixture);
        const clearCountry = async () =>
          await clear.handler(
            createTestHandlerContext<Parameters<typeof clear.handler>[0]>({
              ...context,
              query: { ...context.query, country: "CZE" },
            }),
          );
        const unclassifiable = await clearCountry();
        expect(
          unclassifiable instanceof HttpStatusResponse
            ? unclassifiable.code
            : undefined,
        ).toBe(409);
        await fixture.db
          .update(searchHistoryEntries)
          .set({ countryRepairFailedAt: null })
          .where(eq(searchHistoryEntries.id, saved.id));
        const pending = await clearCountry();
        expect(pending).toBeInstanceOf(HttpStatusResponse);
        expect(
          pending instanceof HttpStatusResponse ? pending.code : undefined,
        ).toBe(409);
        const repair = createSearchHistoryCountryRepair({
          readVerdict: async () => ({ kind: "normal", signals: [] }),
          sleep: async () => {},
        });
        const reserved = await fixture.sql.reserve();
        const connection = {
          execute: async (query, params = []) => {
            await reserved.unsafe(query, [...params]);
          },
          query: async (query, params = []) =>
            await reserved.unsafe(query, [...params]),
          release: async () => {
            await reserved.release();
          },
        } satisfies OnlineMigrationConnection;
        try {
          await repair.repair(
            connection,
            createUngatedTableGateForTests(connection),
          );
        } finally {
          await connection.release();
        }
        const classified = (
          await fixture.db
            .select({
              country: searchHistoryEntries.country,
              countryUsedAt: searchHistoryEntries.countryUsedAt,
              lastUsedAt: searchHistoryEntries.lastUsedAt,
            })
            .from(searchHistoryEntries)
            .where(eq(searchHistoryEntries.id, saved.id))
        ).at(0);
        expect(classified?.country).toBe("CZE");
        expect(classified?.countryUsedAt).toEqual(classified?.lastUsedAt);
        expect(await clearCountry()).toEqual({ deleted: 1 });
      });
    });

    test("scoped deletion barriers retain their country and old base barriers remain global", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "Náhrada škody";
        const saved = await recordQuery(fixture, query, "CZE");
        const original = (
          await fixture.db
            .select()
            .from(searchHistoryEntries)
            .where(eq(searchHistoryEntries.id, saved.id))
        ).at(0);
        if (original === undefined) {
          panic("Expected saved identity");
        }
        await fixture.db
          .delete(searchHistoryEntries)
          .where(eq(searchHistoryEntries.id, saved.id));
        const scopedKey = sha256Hex(
          `search-history-country:v1\u0000CZE\u0000${original.lookupKey}`,
        );
        await fixture.db.insert(searchHistoryTombstones).values({
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          kind: "search",
          lookupKey: scopedKey,
          deletedAt: new Date(),
        });
        const restore = async (country: CaseLawJurisdiction) =>
          await importEntries.handler(
            createTestHandlerContext<
              Parameters<typeof importEntries.handler>[0]
            >({
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query, country },
                    usedAt: "2020-01-02T03:04:05.000Z",
                  },
                ],
              },
            }),
          );
        expect(await restore("CZE")).toEqual({
          entries: 0,
          skipped: 1,
          rejected: 0,
        });
        expect(await restore("POL")).toEqual({
          entries: 1,
          skipped: 0,
          rejected: 0,
        });
        await fixture.db.insert(searchHistoryTombstones).values({
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          kind: "search",
          lookupKey: original.lookupKey,
          deletedAt: new Date(),
        });
        expect(await restore("AUT")).toEqual({
          entries: 0,
          skipped: 1,
          rejected: 0,
        });
        const retained = await fixture.db
          .select({ lookupKey: searchHistoryTombstones.lookupKey })
          .from(searchHistoryTombstones)
          .where(
            eq(searchHistoryTombstones.organizationId, fixture.organizationId),
          );
        expect(retained.map(({ lookupKey }) => lookupKey).toSorted()).toEqual(
          [scopedKey, original.lookupKey].toSorted(),
        );
      });
    });

    test("members and owners can record and read personal history", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const memberEntry = await recordQuery(fixture, "Member query");
        expect((await readHistory(fixture)).items.map(({ id }) => id)).toEqual([
          memberEntry.id,
        ]);
        const owner = { ...fixture, userId: fixture.ownerId };
        const ownerEntry = await recordQuery(owner, "Owner query");
        expect((await readHistory(owner)).items.map(({ id }) => id)).toEqual([
          ownerEntry.id,
        ]);
      });
    });

    test("concurrent normalized records converge to one entry and count every use", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const spellings = [
          "Náhrada škody",
          "  NÁHRADA\t škody  ",
          "Na\u0301hrada  škody",
          "náhrada škody",
        ];
        expect(spellings[2]).not.toBe(
          spellings[2] === undefined
            ? undefined
            : normalizeUnicode(spellings[2], "NFC"),
        );
        const written = await Promise.all(
          spellings.map(async (query) => await recordQuery(fixture, query)),
        );
        expect(new Set(written.map(({ id }) => id)).size).toBe(1);
        const page = await readHistory(fixture);
        expect(page.items).toHaveLength(1);
        expect(page.items.at(0)).toMatchObject({
          kind: "search",
          useCount: spellings.length,
        });
      });
    });

    test("batch import folds repeats, preserves temporal bounds and skips malformed entries", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const entries = [
          {
            entry: { kind: "search", query: " Náhrada škody " },
            usedAt: "2020-01-02T03:04:05.000Z",
          },
          {
            entry: { kind: "search", query: "NÁHRADA\tškody" },
            usedAt: "2020-02-02T03:04:05.000Z",
          },
          {
            entry: { kind: "search", query: "Ignored time" },
            usedAt: "invalid",
          },
          {
            entry: { kind: "search", query: " " },
            usedAt: "2020-02-02T03:04:05.000Z",
          },
          {
            entry: { kind: "unrecognized", query: "Ignored kind" },
            usedAt: "2020-02-02T03:04:05.000Z",
          },
        ];
        const context = createTestHandlerContext<
          Parameters<typeof importEntries.handler>[0]
        >({
          ...identity(fixture),
          body: {
            entries,
            ...(await getImportClockBody(fixture)),
          },
        });
        expect(await importEntries.handler(context)).toEqual({
          entries: 1,
          skipped: 3,
          rejected: 3,
        });
        const first = (await readHistory(fixture)).items.at(0);
        expect(first).toMatchObject({
          kind: "search",
          query: "NÁHRADA škody",
          useCount: 2,
          firstUsedAt: entries[0]?.usedAt,
          lastUsedAt: entries[1]?.usedAt,
        });
        expect(await importEntries.handler(context)).toEqual({
          entries: 1,
          skipped: 3,
          rejected: 3,
        });
        const replay = (await readHistory(fixture)).items;
        expect(replay).toHaveLength(1);
        expect(replay.at(0)).toMatchObject({ id: first?.id, useCount: 2 });
        await recordQuery(fixture, "náhrada škody");
        await importEntries.handler(context);
        const latest = (await readHistory(fixture)).items.at(0);
        expect(latest).toMatchObject({
          id: first?.id,
          query: "náhrada škody",
          useCount: 3,
          firstUsedAt: entries[0]?.usedAt,
        });
        expect(new Date(latest?.lastUsedAt ?? 0).getTime()).toBeGreaterThan(
          new Date(entries[1]?.usedAt ?? 0).getTime(),
        );
      });
    });

    test("an invalid timestamp does not discard a valid neighboring import", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const imported = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: "Invalid timestamp" },
                    usedAt: "-005000-01-01T00:00:00Z",
                  },
                  {
                    entry: { kind: "search", query: "Valid neighbor" },
                    usedAt: "2020-01-02T03:04:05.000Z",
                  },
                ],
              },
            },
          ),
        );

        expect(imported).toEqual({ entries: 1, skipped: 1, rejected: 1 });
        expect(
          (await readHistory(fixture)).items.flatMap((entry) =>
            entry.kind === "search" ? [entry.query] : [],
          ),
        ).toEqual(["Valid neighbor"]);
      });
    });

    test("clear prevents an older import from restoring deleted history", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "Cleared query";
        await recordQuery(fixture, query);
        expect(
          await clear.handler(
            createTestHandlerContext<Parameters<typeof clear.handler>[0]>(
              identity(fixture),
            ),
          ),
        ).toEqual({ deleted: 1 });

        const imported = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                ],
              },
            },
          ),
        );

        expect(imported).toEqual({ entries: 0, skipped: 1, rejected: 0 });
        expect((await readHistory(fixture)).items).toEqual([]);
        const scopedEntries = await fixture.db
          .select()
          .from(searchHistoryEntries)
          .where(
            and(
              eq(searchHistoryEntries.organizationId, fixture.organizationId),
              eq(searchHistoryEntries.userId, fixture.userId),
            ),
          );
        const scopedTombstones = await fixture.db
          .select()
          .from(searchHistoryTombstones)
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
            ),
          );
        expect(scopedEntries).toEqual([]);
        expect(scopedTombstones).toEqual([]);
        expect(JSON.stringify(scopedTombstones)).not.toContain(query);
      });
    });

    test("delete prevents an older import with an equivalent query from restoring history", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "Náhrada škody";
        const original = await recordQuery(fixture, query);
        expect(
          await deleteEntry.handler(
            createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>(
              { ...identity(fixture), params: { entryId: original.id } },
            ),
          ),
        ).toEqual(original);

        const imported = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: "  NÁHRADA\t škody  " },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                  {
                    entry: {
                      kind: "search",
                      query: "náhrada škody",
                      country: "POL",
                    },
                    usedAt: "2020-01-02T00:00:00Z",
                  },
                ],
              },
            },
          ),
        );

        // The deletion holds whichever jurisdiction, or none, an import names.
        expect(imported).toEqual({ entries: 0, skipped: 2, rejected: 0 });
        expect((await readHistory(fixture)).items).toEqual([]);
        const scopedEntries = await fixture.db
          .select()
          .from(searchHistoryEntries)
          .where(
            and(
              eq(searchHistoryEntries.organizationId, fixture.organizationId),
              eq(searchHistoryEntries.userId, fixture.userId),
            ),
          );
        const scopedTombstones = await fixture.db
          .select()
          .from(searchHistoryTombstones)
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
            ),
          );
        expect(scopedEntries).toEqual([]);
        expect(scopedTombstones).toHaveLength(1);
        expect(Object.keys(scopedTombstones.at(0) ?? {}).toSorted()).toEqual([
          "deletedAt",
          "kind",
          "lookupKey",
          "organizationId",
          "userId",
        ]);
        expect(JSON.stringify(scopedTombstones)).not.toContain(query);
      });
    });

    test("only imports a use newer than the deletion cutoff before folding uses", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const original = await recordQuery(fixture, "Náhrada škody");
        const storedEntry = (
          await fixture.db
            .select({ lookupKey: searchHistoryEntries.lookupKey })
            .from(searchHistoryEntries)
            .where(eq(searchHistoryEntries.id, original.id))
        ).at(0);
        if (!storedEntry) {
          panic("Expected the recorded search history entry");
        }
        await deleteEntry.handler(
          createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>({
            ...identity(fixture),
            params: { entryId: original.id },
          }),
        );

        const cutoff = new Date("2026-01-02T03:04:05.000Z");
        await fixture.db
          .update(searchHistoryTombstones)
          .set({ deletedAt: cutoff })
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
              eq(searchHistoryTombstones.kind, "search"),
              eq(searchHistoryTombstones.lookupKey, storedEntry.lookupKey),
            ),
          );

        const imported = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: "Náhrada škody" },
                    usedAt: "2026-01-02T03:04:05.000Z",
                  },
                  {
                    entry: { kind: "search", query: " Náhrada  škody " },
                    usedAt: "2026-01-02T03:04:04.000Z",
                  },
                  {
                    entry: { kind: "search", query: "NÁHRADA\t škody" },
                    usedAt: "2026-01-02T03:04:06.000Z",
                  },
                ],
              },
            },
          ),
        );

        expect(imported).toEqual({ entries: 1, skipped: 2, rejected: 0 });
        expect((await readHistory(fixture)).items).toEqual([
          expect.objectContaining({
            query: "NÁHRADA škody",
            useCount: 1,
            firstUsedAt: "2026-01-02T03:04:06.000Z",
            lastUsedAt: "2026-01-02T03:04:06.000Z",
          }),
        ]);
      });
    });

    test("compacts old deletion identities without restoring stale imports", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const oldestDeletedAt = new Date("2020-01-01T00:00:00.000Z");
        await fixture.db.insert(searchHistoryOwners).values({
          organizationId: fixture.organizationId,
          userId: fixture.userId,
        });
        const seededTombstones = await Promise.all(
          Array.from(
            { length: LIMITS.searchHistoryTombstonesMax },
            async (_, index) => {
              const query = `retention query ${String(index).padStart(3, "0")}`;
              return {
                organizationId: fixture.organizationId,
                userId: fixture.userId,
                kind: "search" as const,
                lookupKey: (
                  await keyedContentLookupKey(
                    fixture.organizationId,
                    `search\u0000${query}`,
                  )
                ).unwrap(),
                deletedAt: new Date(oldestDeletedAt.getTime() + index * 1000),
              };
            },
          ),
        );
        await fixture.db
          .insert(searchHistoryTombstones)
          .values(seededTombstones);
        const ownerRows = await fixture.db
          .select({ tombstoneCutoffAt: searchHistoryOwners.tombstoneCutoffAt })
          .from(searchHistoryOwners)
          .where(
            and(
              eq(searchHistoryOwners.organizationId, fixture.organizationId),
              eq(searchHistoryOwners.userId, fixture.userId),
            ),
          );
        expect(ownerRows.at(0)?.tombstoneCutoffAt).toBeNull();

        const removedQuery = "retention query 000";
        const beforeDelete = await fixture.db
          .select({ lookupKey: searchHistoryTombstones.lookupKey })
          .from(searchHistoryTombstones)
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
            ),
          );
        expect(beforeDelete).toHaveLength(LIMITS.searchHistoryTombstonesMax);
        const removedLookupKey = (
          await keyedContentLookupKey(
            fixture.organizationId,
            `search\u0000${removedQuery}`,
          )
        ).unwrap();
        expect(beforeDelete.map(({ lookupKey }) => lookupKey)).toContain(
          removedLookupKey,
        );

        const live = await recordQuery(
          fixture,
          "New deletion after retention seed",
        );
        await deleteEntry.handler(
          createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>({
            ...identity(fixture),
            params: { entryId: live.id },
          }),
        );

        const retainedTombstones = await fixture.db
          .select({ lookupKey: searchHistoryTombstones.lookupKey })
          .from(searchHistoryTombstones)
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
            ),
          );
        expect(retainedTombstones.length).toBeLessThanOrEqual(
          LIMITS.searchHistoryTombstonesMax,
        );
        expect(
          retainedTombstones.map(({ lookupKey }) => lookupKey),
        ).not.toContain(removedLookupKey);

        const staleImport = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: removedQuery },
                    usedAt: oldestDeletedAt.toISOString(),
                  },
                ],
              },
            },
          ),
        );
        expect(staleImport).toEqual({ entries: 0, skipped: 1, rejected: 0 });
        expect((await readHistory(fixture)).items).toEqual([]);
      });
    });

    test("imports document identity and returns typed unknown metadata for older entries", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const entries = [
          {
            entry: {
              kind: "decision",
              documentId: "decision-known",
              title: "23 Cdo 1001/2021",
              path: "/law/cze/cases/ns/23-cdo-1001-2021",
              courtId: "0191d14d-9a63-7d2e-a021-06053e542c89",
              documentIdentity: {
                kind: "decision",
                courtAbbreviation: "NS",
                courtTier: "supreme",
              },
            },
            usedAt: "2020-01-01T00:00:00Z",
          },
          {
            entry: {
              kind: "decision",
              documentId: "decision-unknown",
              title: "47 C 57/2023",
              path: "/law/cze/cases/ms/47-c-57-2023",
            },
            usedAt: "2020-01-02T00:00:00Z",
          },
          {
            entry: {
              kind: "statute",
              documentId: "/eli/cz/sb/2012/89",
              title: "Občanský zákoník",
              path: "/law/cze/statutes/89-2012",
              documentIdentity: { kind: "statute", number: "89", year: "2012" },
            },
            usedAt: "2020-01-03T00:00:00Z",
          },
          {
            entry: {
              kind: "statute",
              documentId: "/eli/cz/sb/2013/90",
              title: "Statute",
              path: "/law/cze/statutes/90-2013",
            },
            usedAt: "2020-01-04T00:00:00Z",
          },
          {
            entry: {
              kind: "decision",
              documentId: "wrong-decision-identity",
              title: "23 Cdo 1001/2021",
              path: "/law/cze/cases/ns/23-cdo-1001-2021",
              documentIdentity: { kind: "statute", number: "89", year: "2012" },
            },
            usedAt: "2020-01-05T00:00:00Z",
          },
          {
            entry: {
              kind: "statute",
              documentId: "wrong-statute-identity",
              title: "Statute",
              path: "/law/cze/statutes/90-2013",
              documentIdentity: { kind: "decision", courtAbbreviation: "NS" },
            },
            usedAt: "2020-01-06T00:00:00Z",
          },
        ];
        expect(
          await importEntries.handler(
            createTestHandlerContext<
              Parameters<typeof importEntries.handler>[0]
            >({
              ...identity(fixture),
              body: {
                entries,
                ...(await getImportClockBody(fixture)),
              },
            }),
          ),
        ).toEqual({ entries: 4, skipped: 2, rejected: 2 });
        const history = (await readHistory(fixture)).items;
        expect(history).toHaveLength(4);
        expect(history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "decision",
              documentId: "decision-known",
              courtId: "0191d14d-9a63-7d2e-a021-06053e542c89",
              documentIdentity: {
                kind: "decision",
                courtAbbreviation: "NS",
                courtTier: "supreme",
              },
            }),
            expect.objectContaining({
              kind: "decision",
              documentId: "decision-unknown",
              courtId: null,
              documentIdentity: { kind: "unknown" },
            }),
            expect.objectContaining({
              kind: "statute",
              documentId: "/eli/cz/sb/2012/89",
              documentIdentity: { kind: "statute", number: "89", year: "2012" },
            }),
            expect.objectContaining({
              kind: "statute",
              documentId: "/eli/cz/sb/2013/90",
              documentIdentity: { kind: "unknown" },
            }),
          ]),
        );
      });
    });

    test("display pagination preserves stored entries and supports kind filters", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const usedAt = new Date("2020-01-01T00:00:00.000Z");
        const rows = await prepareSearchHistoryRows(
          fixture,
          Array.from({ length: 25 }, (_, index) => ({
            entry: { kind: "search" as const, query: `Query ${index}` },
            usedAt,
          })),
        );
        await fixture.db.transaction(
          async (tx) =>
            await upsertSearchHistoryRows({
              tx,
              rows,
              mode: "record",
              timestampSource: "prepared",
              recordAuditEvent: historyAuditRecorder(fixture),
            }),
        );
        // Every timestamp shares a JavaScript millisecond but has distinct Postgres precision.
        await fixture.db.execute(sql`
          WITH ordered AS (
            SELECT id, row_number() OVER (ORDER BY id) AS position
            FROM search_history_entries WHERE user_id = ${fixture.userId}
          )
          UPDATE search_history_entries history
          SET last_used_at = '2020-01-01T00:00:00.123000Z'::timestamptz + ordered.position * interval '1 microsecond'
          FROM ordered WHERE history.id = ordered.id
        `);
        const first = await readHistory(fixture);
        expect(first.items).toHaveLength(20);
        expect(first.nextCursor).not.toBeNull();
        if (!first.nextCursor) {
          panic("Expected next history page");
        }
        const second = await readHistory(fixture, { cursor: first.nextCursor });
        expect(second.items).toHaveLength(5);
        expect(second.nextCursor).toBeNull();
        expect(
          new Set([...first.items, ...second.items].map(({ id }) => id)).size,
        ).toBe(25);
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            eq(searchHistoryEntries.userId, fixture.userId),
          ),
        ).toBe(25);
        expect(
          (await readHistory(fixture, { kind: "decision" })).items,
        ).toEqual([]);
        const invalid = await list.handler(
          createTestHandlerContext<Parameters<typeof list.handler>[0]>({
            ...identity(fixture),
            query: { cursor: "invalid" },
          }),
        );
        expect(invalid).toBeInstanceOf(HttpStatusResponse);
        if (invalid instanceof HttpStatusResponse) {
          expect(invalid.code).toBe(400);
        }
      });
    });

    test("the latest use naming a jurisdiction files an entry, whatever order uses arrive in", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const at = (minute: number) =>
          new Date(NOW.getTime() - 60 * 60_000 + minute * 60_000);
        const importUses = async (
          uses: Parameters<typeof prepareSearchHistoryRows>[1],
        ) => {
          const rows = await prepareSearchHistoryRows(fixture, uses);
          await fixture.db.transaction(
            async (tx) =>
              await upsertSearchHistoryRows({
                tx,
                rows,
                mode: "import",
                timestampSource: "prepared",
                recordAuditEvent: historyAuditRecorder(fixture),
              }),
          );
        };
        const filed = async (country: CaseLawJurisdiction) =>
          (await readHistory(fixture, { country })).items.map(
            (item) => item.kind,
          );

        // One batch, out of order: the use without a jurisdiction is the
        // latest, POL is the latest that names one.
        await importUses([
          {
            entry: {
              kind: "search",
              query: "Odpowiedzialność",
              country: "CZE",
            },
            usedAt: at(1),
          },
          {
            entry: { kind: "search", query: "Odpowiedzialność" },
            usedAt: at(3),
          },
          {
            entry: {
              kind: "search",
              query: "Odpowiedzialność",
              country: "POL",
            },
            usedAt: at(2),
          },
        ]);
        expect(await filed("POL")).toEqual(["search"]);
        expect(await filed("CZE")).toEqual([]);

        // A later batch carrying an older jurisdiction-naming use keeps it.
        await importUses([
          {
            entry: {
              kind: "search",
              query: "odpowiedzialność",
              country: "CZE",
            },
            usedAt: at(0),
          },
        ]);
        expect(await filed("POL")).toEqual(["search"]);
        expect(await filed("CZE")).toEqual([]);

        // A newer one refiles it.
        await importUses([
          {
            entry: {
              kind: "search",
              query: "odpowiedzialność",
              country: "CZE",
            },
            usedAt: at(4),
          },
        ]);
        expect(await filed("CZE")).toEqual(["search"]);
        expect(await filed("POL")).toEqual([]);
      });
    });

    test("country filters use the latest jurisdiction and its own counted uses", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const refiled = await recordQuery(fixture, "Náhrada škody", "CZE");
        const czechQuery = await recordQuery(fixture, "Zástavní právo", "CZE");
        // One query is one entry: the latest jurisdiction it ran under files it.
        const polishQuery = await recordQuery(fixture, "náhrada  škody", "POL");
        expect(polishQuery.id).toBe(refiled.id);
        const polishDecision = await recordEntry(fixture, {
          kind: "decision",
          documentId: "01a16610-b177-712f-bff9-4732ef2df307",
          title: "II CSKP 61/24",
          path: "/law/pol/cases/sad-najwyzszy/ii-cskp-61-24",
        });
        const legacyRows = await prepareSearchHistoryRows(fixture, [
          {
            entry: { kind: "search", query: "kept before countries" },
            usedAt: new Date(NOW.getTime() - 60_000),
          },
          {
            // A use kept before jurisdictions never unfiles its entry.
            entry: { kind: "search", query: "NÁHRADA škody" },
            usedAt: new Date(NOW.getTime() - 60_000),
          },
        ]);
        await fixture.db.transaction(
          async (tx) =>
            await upsertSearchHistoryRows({
              tx,
              rows: legacyRows,
              mode: "import",
              timestampSource: "prepared",
              recordAuditEvent: historyAuditRecorder(fixture),
            }),
        );

        const czech = await readHistory(fixture, { country: "CZE" });
        expect(czech.items.map(({ id }) => id)).toEqual([czechQuery.id]);
        expect(czech.items.at(0)).toMatchObject({
          kind: "search",
          country: "CZE",
        });
        const polish = await readHistory(fixture, { country: "POL" });
        expect(new Set(polish.items.map(({ id }) => id))).toEqual(
          new Set([polishQuery.id, polishDecision.id]),
        );
        expect(
          polish.items.find(({ id }) => id === polishQuery.id),
        ).toMatchObject({ useCount: 1 });
        expect(polish.items.every(({ country }) => country === "POL")).toBe(
          true,
        );
        expect(
          (await readHistory(fixture, { country: "POL", kind: "decision" }))
            .items,
        ).toMatchObject([{ id: polishDecision.id, country: "POL" }]);
        const unscoped = await readHistory(fixture);
        expect(unscoped.items).toHaveLength(4);
        expect(
          unscoped.items.find(({ country }) => country === null),
        ).toMatchObject({ kind: "search", query: "kept before countries" });
      });
    });

    test("delete erases one entry and clear erases only the active owner's remaining entries", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const first = await recordQuery(fixture, "First");
        const second = await recordQuery(fixture, "Second");
        const other = await recordQuery(
          { ...fixture, userId: fixture.otherUserId },
          "Other",
        );
        const elsewhere = await recordQuery(
          { ...fixture, organizationId: fixture.otherOrganizationId },
          "Elsewhere",
        );
        expect(
          await deleteEntry.handler(
            createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>(
              { ...identity(fixture), params: { entryId: first.id } },
            ),
          ),
        ).toEqual(first);
        expect((await readHistory(fixture)).items.map(({ id }) => id)).toEqual([
          second.id,
        ]);
        expect(
          await clear.handler(
            createTestHandlerContext<Parameters<typeof clear.handler>[0]>(
              identity(fixture),
            ),
          ),
        ).toEqual({ deleted: 1 });
        expect(
          await clear.handler(
            createTestHandlerContext<Parameters<typeof clear.handler>[0]>(
              identity(fixture),
            ),
          ),
        ).toEqual({ deleted: 0 });
        expect((await readHistory(fixture)).items).toEqual([]);
        expect(
          await fixture.db
            .select({ id: searchHistoryEntries.id })
            .from(searchHistoryEntries)
            .where(inArray(searchHistoryEntries.id, [other.id, elsewhere.id])),
        ).toEqual(expect.arrayContaining([other, elsewhere]));
      });
    });

    test("member removal clears that organization's history and rejoining starts empty", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const own = await recordQuery(fixture, "Departing");
        const other = await recordQuery(
          { ...fixture, userId: fixture.otherUserId },
          "Remaining",
        );
        const elsewhere = await recordQuery(
          { ...fixture, organizationId: fixture.otherOrganizationId },
          "Elsewhere",
        );
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            eq(searchHistoryEntries.id, own.id),
          ),
        ).toBe(1);
        await fixture.db.transaction(
          async (tx) =>
            await removeOrganizationMemberInTransaction(tx, {
              organizationId: fixture.organizationId,
              memberId: fixture.memberId,
              userId: fixture.userId,
              actorUserId: fixture.ownerId,
            }),
        );
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            eq(searchHistoryEntries.id, own.id),
          ),
        ).toBe(0);
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            inArray(searchHistoryEntries.id, [other.id, elsewhere.id]),
          ),
        ).toBe(2);
        expect(
          await fixture.db.$count(
            searchHistoryOwners,
            and(
              eq(searchHistoryOwners.organizationId, fixture.organizationId),
              eq(searchHistoryOwners.userId, fixture.userId),
            ),
          ),
        ).toBe(0);
        expect(
          await fixture.db.$count(
            searchHistoryTombstones,
            and(
              eq(
                searchHistoryTombstones.organizationId,
                fixture.organizationId,
              ),
              eq(searchHistoryTombstones.userId, fixture.userId),
            ),
          ),
        ).toBe(0);
        const staleRecord = await record.handler(
          createTestHandlerContext<Parameters<typeof record.handler>[0]>({
            ...identity(fixture),
            body: { kind: "search", query: "Stale record", country: "CZE" },
          }),
        );
        const staleImport = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: "Stale import" },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                ],
              },
            },
          ),
        );
        for (const response of [staleRecord, staleImport]) {
          expect(response).toBeInstanceOf(HttpStatusResponse);
          if (response instanceof HttpStatusResponse) {
            expect(response.code).toBe(403);
          }
        }
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            and(
              eq(searchHistoryEntries.organizationId, fixture.organizationId),
              eq(searchHistoryEntries.userId, fixture.userId),
            ),
          ),
        ).toBe(0);
        const joinedAt = new Date("2026-01-02T03:04:05.000Z");
        await fixture.db.insert(member).values({
          id: Bun.randomUUIDv7(),
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          role: "member",
          createdAt: joinedAt,
        });
        const preRejoinImport = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: "Departing" },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                  {
                    entry: { kind: "search", query: "Before rejoin" },
                    usedAt: "2026-01-02T03:04:04.000Z",
                  },
                  {
                    entry: { kind: "search", query: "At rejoin" },
                    usedAt: joinedAt.toISOString(),
                  },
                ],
              },
            },
          ),
        );
        expect(preRejoinImport).toEqual({
          entries: 0,
          skipped: 3,
          rejected: 0,
        });
        expect((await readHistory(fixture)).items).toEqual([]);

        const postRejoinImport = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query: "Fresh after rejoin" },
                    usedAt: "2026-01-02T03:04:06.000Z",
                  },
                ],
              },
            },
          ),
        );
        expect(postRejoinImport).toEqual({
          entries: 1,
          skipped: 0,
          rejected: 0,
        });
        expect((await readHistory(fixture)).items).toMatchObject([
          {
            kind: "search",
            query: "Fresh after rejoin",
            useCount: 1,
          },
        ]);
      });
    });

    test("a failed audit write rolls back the history mutation and its audit row", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const actualRecorder = historyAuditRecorder(fixture);
        let auditInserted = false;
        const interruptedRecorder: AuditRecorder = async (tx, event) => {
          await actualRecorder(tx, event);
          auditInserted = true;
          return panic("search history audit fixture interruption");
        };
        const response = await record.handler(
          createTestHandlerContext<Parameters<typeof record.handler>[0]>({
            ...identity(fixture),
            audit: interruptedRecorder,
            body: { kind: "search", query: "Atomic record", country: "CZE" },
          }),
        );
        expect(auditInserted).toBe(true);
        expect(response).toBeInstanceOf(HttpStatusResponse);
        if (response instanceof HttpStatusResponse) {
          expect(response.code).toBe(500);
        }
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            eq(searchHistoryEntries.userId, fixture.userId),
          ),
        ).toBe(0);
        expect(
          await fixture.db.$count(
            auditLogs,
            eq(auditLogs.organizationId, fixture.organizationId),
          ),
        ).toBe(0);
      });
    });

    test("all history mutations audit ownership and metadata without retaining entry content", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        const query = "audit-private-query-unique";
        const decision = {
          kind: "decision" as const,
          documentId: "audit-private-decision",
          title: "audit-private-decision-title",
          path: "/law/cze/cases/private-court/audit-private-decision",
          courtId: "audit-private-court",
          documentIdentity: {
            kind: "decision" as const,
            courtAbbreviation: "PRIVATE",
            courtTier: "supreme" as const,
          },
        };
        const statute = {
          kind: "statute" as const,
          documentId: "audit-private-statute",
          title: "audit-private-statute-title",
          path: "/law/cze/statutes/audit-private-statute",
          documentIdentity: {
            kind: "statute" as const,
            number: "971",
            year: "2049",
          },
        };
        const recorded = await recordQuery(fixture, query);
        for (const body of [decision, statute]) {
          const response = await record.handler(
            createTestHandlerContext<Parameters<typeof record.handler>[0]>({
              ...identity(fixture),
              body,
            }),
          );
          expect(response).not.toBeInstanceOf(HttpStatusResponse);
        }
        expect(
          await importEntries.handler(
            createTestHandlerContext<
              Parameters<typeof importEntries.handler>[0]
            >({
              ...identity(fixture),
              body: {
                ...(await getImportClockBody(fixture)),
                entries: [
                  {
                    entry: { kind: "search", query },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                ],
              },
            }),
          ),
        ).toEqual({ entries: 1, skipped: 0, rejected: 0 });
        const lookupKeys = await fixture.db
          .select({ lookupKey: searchHistoryEntries.lookupKey })
          .from(searchHistoryEntries)
          .where(eq(searchHistoryEntries.userId, fixture.userId));
        expect(lookupKeys).toHaveLength(3);
        expect(
          await deleteEntry.handler(
            createTestHandlerContext<Parameters<typeof deleteEntry.handler>[0]>(
              { ...identity(fixture), params: { entryId: recorded.id } },
            ),
          ),
        ).toEqual(recorded);
        expect(
          await clear.handler(
            createTestHandlerContext<Parameters<typeof clear.handler>[0]>(
              identity(fixture),
            ),
          ),
        ).toEqual({ deleted: 2 });
        const events = await fixture.db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, fixture.organizationId),
              eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.SEARCH_HISTORY),
            ),
          );
        expect(events).toHaveLength(6);
        for (const event of events) {
          expect(event).toMatchObject({
            organizationId: fixture.organizationId,
            userId: fixture.userId,
            workspaceId: null,
            performerType: "user",
            performerId: fixture.userId,
            changes: null,
          });
        }
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: AUDIT_ACTION.UPDATE,
              resourceId: fixture.userId,
              metadata: {
                operation: "record",
                entryCount: 1,
                kinds: [],
              },
            }),
            expect.objectContaining({
              action: AUDIT_ACTION.UPDATE,
              resourceId: fixture.userId,
              metadata: {
                operation: "record",
                entryCount: 1,
                kinds: ["case_law"],
              },
            }),
            expect.objectContaining({
              action: AUDIT_ACTION.UPDATE,
              resourceId: fixture.userId,
              metadata: {
                operation: "record",
                entryCount: 1,
                kinds: ["statute"],
              },
            }),
            expect.objectContaining({
              action: AUDIT_ACTION.UPDATE,
              resourceId: fixture.userId,
              metadata: {
                operation: "import",
                entryCount: 1,
                kinds: [],
              },
            }),
            expect.objectContaining({
              action: AUDIT_ACTION.DELETE,
              resourceId: recorded.id,
              metadata: {
                operation: "delete",
                entryCount: 1,
                kinds: [],
              },
            }),
          ]),
        );
        const cleared = events.find(
          ({ metadata }) => metadata?.["operation"] === "clear",
        );
        expect(cleared).toMatchObject({
          action: AUDIT_ACTION.DELETE,
          resourceId: fixture.userId,
          metadata: {
            operation: "clear",
            entryCount: 2,
          },
        });
        expect(cleared?.metadata?.["kinds"]).toHaveLength(2);
        expect(cleared?.metadata?.["kinds"]).toEqual(
          expect.arrayContaining(["case_law", "statute"]),
        );
        for (const { metadata } of events) {
          expect(Object.keys(metadata ?? {}).toSorted()).toEqual([
            "entryCount",
            "kinds",
            "operation",
          ]);
        }
        expect(
          events.filter(({ action }) => action === AUDIT_ACTION.DELETE),
        ).toHaveLength(2);
        expect(
          events.find(
            ({ resourceId, action }) =>
              resourceId === recorded.id && action === AUDIT_ACTION.DELETE,
          )?.action,
        ).toBe(AUDIT_ACTION.DELETE);
        const storedEntries = await fixture.db
          .select({ lookupKey: searchHistoryEntries.lookupKey })
          .from(searchHistoryEntries)
          .where(eq(searchHistoryEntries.userId, fixture.userId));
        expect(storedEntries).toEqual([]);
        const serialized = JSON.stringify(
          events.map(({ metadata, changes }) => ({ metadata, changes })),
        );
        for (const content of [
          query,
          decision.documentId,
          decision.title,
          decision.path,
          decision.courtId,
          decision.documentIdentity.courtAbbreviation,
          statute.documentId,
          statute.title,
          statute.path,
          statute.documentIdentity.number,
          statute.documentIdentity.year,
          ...lookupKeys.map(({ lookupKey }) => lookupKey),
        ]) {
          expect(serialized).not.toContain(content);
        }
        for (const field of [
          "query",
          "title",
          "path",
          "courtId",
          "documentIdentity",
          "courtAbbreviation",
          "courtTier",
          "statuteNumber",
          "statuteYear",
          "lookupKey",
          "ciphertext",
          "iv",
        ]) {
          expect(
            events.every(
              (event) => !Object.hasOwn(event.metadata ?? {}, field),
            ),
          ).toBe(true);
        }
      });
    });

    test("account deletion erases personal history across organizations and preserves other users", async () => {
      await withHistory(databaseUrl, async (fixture) => {
        await recordQuery(fixture, "Account entry");
        await recordQuery(
          { ...fixture, organizationId: fixture.otherOrganizationId },
          "Other organization",
        );
        const other = await recordQuery(
          { ...fixture, userId: fixture.otherUserId },
          "Other member",
        );
        const ownRows = () =>
          fixture.db.$count(
            searchHistoryEntries,
            and(
              eq(searchHistoryEntries.userId, fixture.userId),
              inArray(searchHistoryEntries.organizationId, [
                fixture.organizationId,
                fixture.otherOrganizationId,
              ]),
            ),
          );
        expect(await ownRows()).toBe(2);
        await fixture.db.transaction(
          async (tx) => await deleteSearchHistory(tx, fixture.userId),
        );
        expect(await ownRows()).toBe(0);
        expect(
          await fixture.db.$count(
            searchHistoryEntries,
            eq(searchHistoryEntries.id, other.id),
          ),
        ).toBe(1);
        const deletionEvents = await fixture.db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.userId, fixture.userId),
              eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.SEARCH_HISTORY),
              eq(auditLogs.action, AUDIT_ACTION.DELETE),
            ),
          );
        expect(deletionEvents).toHaveLength(2);
        expect(
          deletionEvents.map(({ organizationId }) => organizationId),
        ).toEqual(
          expect.arrayContaining([
            fixture.organizationId,
            fixture.otherOrganizationId,
          ]),
        );
        for (const event of deletionEvents) {
          expect(event).toMatchObject({
            resourceId: fixture.userId,
            workspaceId: null,
            performerId: fixture.userId,
            changes: null,
            metadata: {
              operation: "account-deletion",
              entryCount: 1,
              kinds: [],
            },
          });
          expect(Object.keys(event.metadata ?? {}).toSorted()).toEqual([
            "entryCount",
            "kinds",
            "operation",
          ]);
        }

        await fixture.db.transaction(
          async (tx) => await deleteSearchHistory(tx, fixture.userId),
        );
        expect(await ownRows()).toBe(0);
      });
    });
  });
}
