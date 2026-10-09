import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  searchHistoryEntries,
  searchHistoryOwners,
  searchHistoryTombstones,
} from "@/api/db/schema";
import type { RlsDatabaseMarker } from "@/api/db/scoped";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { deleteSearchHistory } from "@/api/lib/account-deletion-steps";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { keyedContentLookupKey } from "@/api/lib/content-encryption";
import { LIMITS } from "@/api/lib/limits";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import clear from "./clear";
import deleteEntry from "./delete";
import { prepareSearchHistoryRows, upsertSearchHistoryRows } from "./entries";
import importEntries from "./import";
import list from "./list";
import record from "./upsert";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type HistoryFixture = {
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
    const { db } = openClient({ max: 4 });
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
      await db.insert(member).values([
        {
          id: memberId,
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: Bun.randomUUIDv7(),
          organizationId,
          userId: otherUserId,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: Bun.randomUUIDv7(),
          organizationId,
          userId: ownerId,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: Bun.randomUUIDv7(),
          organizationId: otherOrganizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      ]);
      const rlsDb = markRlsDatabase(db);
      await work({
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

if (!databaseUrl || !enabled) {
  describe.skip("search history (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("search history (postgres)", () => {
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
        expect(spellings[2]).not.toBe(spellings[2]?.normalize("NFC"));
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
        >({ ...identity(fixture), body: { entries } });
        expect(await importEntries.handler(context)).toEqual({
          entries: 1,
          skipped: 3,
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

        expect(imported).toEqual({ entries: 0, skipped: 1 });
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
                entries: [
                  {
                    entry: { kind: "search", query: "  NÁHRADA\t škody  " },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                ],
              },
            },
          ),
        );

        expect(imported).toEqual({ entries: 0, skipped: 1 });
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

        expect(imported).toEqual({ entries: 1, skipped: 2 });
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
                lookupKey: await keyedContentLookupKey(
                  fixture.organizationId,
                  `search\u0000${query}`,
                ),
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
        const removedLookupKey = await keyedContentLookupKey(
          fixture.organizationId,
          `search\u0000${removedQuery}`,
        );
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
        expect(staleImport).toEqual({ entries: 0, skipped: 1 });
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
            >({ ...identity(fixture), body: { entries } }),
          ),
        ).toEqual({ entries: 4, skipped: 2 });
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
        expect(invalid).toBeInstanceOf(ElysiaCustomStatusResponse);
        if (invalid instanceof ElysiaCustomStatusResponse) {
          expect(invalid.code).toBe(400);
        }
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
        const staleRecord = await record.handler(
          createTestHandlerContext<Parameters<typeof record.handler>[0]>({
            ...identity(fixture),
            body: { kind: "search", query: "Stale record" },
          }),
        );
        const staleImport = await importEntries.handler(
          createTestHandlerContext<Parameters<typeof importEntries.handler>[0]>(
            {
              ...identity(fixture),
              body: {
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
          expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
          if (response instanceof ElysiaCustomStatusResponse) {
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
        await fixture.db.insert(member).values({
          id: Bun.randomUUIDv7(),
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          role: "member",
          createdAt: new Date(),
        });
        expect((await readHistory(fixture)).items).toEqual([]);
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
            body: { kind: "search", query: "Atomic record" },
          }),
        );
        expect(auditInserted).toBe(true);
        expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
        if (response instanceof ElysiaCustomStatusResponse) {
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
          expect(response).not.toBeInstanceOf(ElysiaCustomStatusResponse);
        }
        expect(
          await importEntries.handler(
            createTestHandlerContext<
              Parameters<typeof importEntries.handler>[0]
            >({
              ...identity(fixture),
              body: {
                entries: [
                  {
                    entry: { kind: "search", query },
                    usedAt: "2020-01-01T00:00:00Z",
                  },
                ],
              },
            }),
          ),
        ).toEqual({ entries: 1, skipped: 0 });
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
