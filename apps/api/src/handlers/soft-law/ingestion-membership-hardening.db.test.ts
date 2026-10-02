import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, getTableColumns, getTableName, sql } from "drizzle-orm";

import { stellaIngestion } from "@/api/db/rls";
import {
  softLawSources,
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
  softLawIngestionAttempts,
} from "@/api/db/schema";
import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import type { SoftLawSourceAdapter } from "@/api/lib/legal-search/soft-law-types";
import {
  adapter,
  document,
  entry,
  withSource,
} from "@/api/tests/soft-law-ingestion-support";

const softLawSchema = {
  softLawSources,
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
  softLawIngestionAttempts,
};
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const SOURCE_WRITES = {
  id: "immutable",
  adapterKey: "immutable",
  descriptor: "immutable",
  syncCursor: "update",
  listingBaseline: "update",
  listingSeen: "update",
  listingExpectedTotal: "update",
  lastSyncAt: "update",
  runState: "update",
  runId: "update",
  runStartedAt: "update",
  leaseToken: "update",
  leaseExpiresAt: "update",
  failureTag: "update",
} as const satisfies Record<
  keyof typeof softLawSources.$inferSelect,
  "update" | "immutable"
>;

const sqlState = (error: unknown): string | undefined => {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    if (!("cause" in current)) {
      return undefined;
    }
    current = current.cause;
  }
  return undefined;
};

if (!databaseUrl || !enabled) {
  describe.skip("guidance membership and ingestion privileges on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("ingestion privileges match the operational source contract", () => {
    test("every source column has an explicit decision and only operational columns are writable", async () =>
      await withSource(databaseUrl, async ({ db, run }) => {
        expect(await run(adapter([entry()]))).toEqual({ status: "complete" });
        const columns = new Map(
          Object.entries(getTableColumns(softLawSources)),
        );
        const expected = Object.entries(SOURCE_WRITES)
          .filter(([, disposition]) => disposition === "update")
          .map(
            ([key]) =>
              columns.get(key)?.name ?? panic(`Unknown source column: ${key}`),
          );
        const privileges = await db
          .select({
            name: sql<string>`a.attname`.as("column_name"),
            update:
              sql<boolean>`has_column_privilege(${stellaIngestion.name}, a.attrelid, a.attname, 'UPDATE')`.as(
                "can_update",
              ),
          })
          .from(sql`pg_attribute a`)
          .where(
            sql`a.attrelid = 'soft_law_sources'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
          );
        expect(privileges.map((row) => row.name).toSorted()).toEqual(
          [...columns.values()].map((column) => column.name).toSorted(),
        );
        expect(
          privileges
            .filter((row) => row.update)
            .map((row) => row.name)
            .toSorted(),
        ).toEqual(expected.toSorted());

        const familyTables = await db.execute<{ name: string }>(sql`
          SELECT relation.relname AS name
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
            AND starts_with(relation.relname, 'soft_law_')
        `);
        expect(familyTables.map(({ name }) => name).toSorted()).toEqual(
          Object.values(softLawSchema).map(getTableName).toSorted(),
        );
        const statements = [
          {
            action: "INSERT soft_law_sources",
            statement: sql`INSERT INTO ${softLawSources} DEFAULT VALUES`,
          },
          ...Object.values(softLawSchema).map((table) => ({
            action: `DELETE ${getTableName(table)}`,
            statement: sql`DELETE FROM ${table} WHERE false`,
          })),
        ];
        for (const { action, statement } of statements) {
          const denied = await Result.tryPromise(
            async () =>
              await db.transaction(async (tx) => {
                await tx.execute(
                  sql.raw(`SET LOCAL ROLE "${stellaIngestion.name}"`),
                );
                await tx.execute(statement);
              }),
          );
          if (!Result.isError(denied)) {
            panic(`Ingestion received a forbidden privilege: ${action}`);
          }
          expect(sqlState(denied.error.cause), action).toBe("42501");
        }
      }));
  });

  describe("small-source completeness rounds the minimum upward", () => {
    for (const baseline of [3, 5]) {
      test(`a ${baseline}-item baseline ${baseline === 3 ? "withholds 2" : "allows 4"} listed items`, async () =>
        await withSource(databaseUrl, async ({ db, sourceId, run }) => {
          const original = Array.from({ length: baseline }, (_, index) =>
            entry(
              `https://uoou.gov.cz/guidance-${index}`,
              `Guidance ${index}`,
              `REF-${index}`,
            ),
          );
          expect(await run(adapter(original))).toEqual({ status: "complete" });
          const retained = original.slice(0, baseline - 1);
          const result = await run(adapter(retained));
          const rows = await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId));
          expect(rows).toHaveLength(baseline);
          const locators = await db
            .select()
            .from(softLawDocumentLocators)
            .where(eq(softLawDocumentLocators.sourceId, sourceId));
          expect(locators).toHaveLength(baseline);
          if (baseline === 3) {
            expect(result).toMatchObject({
              status: "listing_incomplete",
              seen: 2,
              baseline: 3,
              expectedTotal: null,
            });
            expect(rows.every((row) => row.listingState === "listed")).toBe(
              true,
            );
            expect(locators.every((row) => row.state === "current")).toBe(true);
            expect(
              (
                await db
                  .select()
                  .from(softLawSources)
                  .where(eq(softLawSources.id, sourceId))
              ).at(0),
            ).toMatchObject({
              runState: "listing_incomplete",
              failureTag: "listing_incomplete",
              listingBaseline: 3,
              listingSeen: 2,
            });
          } else {
            expect(result).toEqual({ status: "complete" });
            expect(
              rows.filter((row) => row.listingState === "listed"),
            ).toHaveLength(4);
            expect(
              rows.filter((row) => row.listingState === "no_longer_listed"),
            ).toHaveLength(1);
            expect(
              locators
                .filter((row) => row.state === "historical")
                .map((row) => row.url),
            ).toEqual([original.at(-1)?.url]);
          }
        }));
    }
  });

  describe("terminal body rejection still establishes current listing membership", () => {
    for (const mode of [
      "invalid_document",
      "retry_exhausted",
      "ambiguous_locator",
    ] as const) {
      test(`${mode} refreshes membership while preserving the accepted document and raw version`, async () =>
        await withSource(databaseUrl, async ({ db, sourceId, run }) => {
          const original = entry();
          expect(await run(adapter([original]))).toEqual({
            status: "complete",
          });
          const old = new Date("2024-01-01T00:00:00Z");
          await db
            .update(softLawDocuments)
            .set({ firstSeenAt: old, lastSeenAt: old })
            .where(eq(softLawDocuments.sourceId, sourceId));
          await db
            .update(softLawDocumentLocators)
            .set({ firstSeenAt: old, lastSeenAt: old })
            .where(eq(softLawDocumentLocators.sourceId, sourceId));
          const before =
            (
              await db
                .select()
                .from(softLawDocuments)
                .where(eq(softLawDocuments.sourceId, sourceId))
            ).at(0) ?? panic("Original document missing");
          const beforeLocator =
            (
              await db
                .select()
                .from(softLawDocumentLocators)
                .where(eq(softLawDocumentLocators.sourceId, sourceId))
            ).at(0) ?? panic("Original locator missing");
          const versions = await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, before.id));
          expect(versions).toHaveLength(1);
          expect(versions.at(0)?.rawObjects.length).toBeGreaterThan(0);

          const replacement = entry(original.url, "Other guidance", "03/2024");
          const sourceAdapter = {
            ...adapter([mode === "ambiguous_locator" ? replacement : original]),
            fetchDocument: async (item) => {
              if (mode === "retry_exhausted") {
                return Result.err(
                  new SoftLawAccessError({
                    message: "Publisher body is temporarily unavailable",
                  }),
                );
              }
              const input = document(item, "unaccepted replacement bytes");
              return Result.ok(
                mode === "invalid_document"
                  ? { ...input, metadata: { ...input.metadata, title: "" } }
                  : input,
              );
            },
          } as const satisfies SoftLawSourceAdapter;
          const rounds = mode === "retry_exhausted" ? 3 : 1;
          for (let round = 0; round < rounds; round++) {
            expect(await run(sourceAdapter)).toEqual({
              status: round === rounds - 1 ? "complete" : "paused",
            });
          }
          const rejection = (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).find(
            (attempt) =>
              attempt.url === original.url && attempt.status === "rejected",
          );
          expect(rejection).toMatchObject({ tag: mode, count: rounds });
          if (!rejection) {
            panic("Final rejection receipt missing");
          }
          const after =
            (
              await db
                .select()
                .from(softLawDocuments)
                .where(eq(softLawDocuments.sourceId, sourceId))
            ).at(0) ?? panic("Rejected document was lost");
          const afterLocator =
            (
              await db
                .select()
                .from(softLawDocumentLocators)
                .where(eq(softLawDocumentLocators.sourceId, sourceId))
            ).at(0) ?? panic("Rejected locator was lost");
          expect(after.listingState).toBe("listed");
          expect(afterLocator.state).toBe("current");
          expect(after.lastSeenAt.getTime()).toBeGreaterThan(
            before.lastSeenAt.getTime(),
          );
          expect(afterLocator.lastSeenAt.getTime()).toBeGreaterThan(
            beforeLocator.lastSeenAt.getTime(),
          );
          expect(after.lastSeenRun).toBe(rejection.runId);
          expect(afterLocator.lastSeenRun).toBe(rejection.runId);
          expect(after.lastSeenRun).not.toBe(before.lastSeenRun);
          expect(after).toEqual({
            ...before,
            lastSeenAt: after.lastSeenAt,
            lastSeenRun: rejection.runId,
          });
          expect(afterLocator).toEqual({
            ...beforeLocator,
            lastSeenAt: afterLocator.lastSeenAt,
            lastSeenRun: rejection.runId,
          });
          expect(
            await db
              .select()
              .from(softLawDocumentVersions)
              .where(eq(softLawDocumentVersions.documentId, before.id)),
          ).toEqual(versions);
          expect(
            await db
              .select()
              .from(softLawDocuments)
              .where(eq(softLawDocuments.sourceId, sourceId)),
          ).toHaveLength(1);
          expect(
            await db
              .select()
              .from(softLawDocumentLocators)
              .where(eq(softLawDocumentLocators.sourceId, sourceId)),
          ).toHaveLength(1);
        }));
    }
  });
}
