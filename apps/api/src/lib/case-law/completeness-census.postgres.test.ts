import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCompletenessCensus,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { createSafeId } from "@/api/lib/branded-types";
import {
  censusScope,
  currentCensusSourceScopes,
  readCompletenessCensusQuery,
  recordCompletenessCensus,
} from "@/api/lib/case-law/completeness-census";
import { countryCensusVerdict } from "@/api/lib/case-law/completeness-census-contract";
import type {
  ListingIdentity,
  SourceSliceWalk,
} from "@/api/lib/legal-search/ingestion-types";
import { publicLawDatabaseRolePermissionsSql } from "@/api/lib/public-law-read-db";
import { PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION } from "@/api/lib/public-law-relations";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "publisher completeness observations (postgres)",
  () => {
    test("partial publisher counts remain visible, undated slices omit year zero, and the persisted text threshold is exact", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("Postgres census test requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const schema = sql.identifier(
          `census_boundaries_${Bun.randomUUIDv7().replaceAll("-", "")}`,
        );
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of [
            "case_law_sources",
            "case_law_decisions",
            "case_law_completeness_census",
          ]) {
            await db.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await db.execute(sql`SET search_path TO ${schema}, public`);
          const scopedDb: ScopedDb = async (callback) =>
            await db.transaction(callback);
          const sourceId = createSafeId<"caseLawSource">();
          const partialSourceId = createSafeId<"caseLawSource">();
          const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
          const observedAt = new Date("2026-10-16T12:00:00Z");
          await db.insert(caseLawSources).values([
            {
              id: sourceId,
              adapterKey: "cz-ns",
              name: "Text threshold fixture",
              ingestionLeaseToken: leaseToken,
              ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
            },
            {
              id: partialSourceId,
              adapterKey: "pl-kio",
              name: "Partial publisher fixture",
              ingestionLeaseToken: leaseToken,
              ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
            },
          ]);
          await db.execute(sql`INSERT INTO case_law_decisions
          (id, source_id, source_document_id, case_number, court, country, language, fulltext)
          SELECT gen_random_uuid(), ${sourceId}, 'threshold-' || n, 'threshold/' || n,
            'Fixture', 'CZE', 'cs', CASE WHEN n <= 998 THEN 'Decision text' ELSE '' END
          FROM generate_series(1, 1000) n`);
          await db.insert(caseLawDecisions).values({
            sourceId: partialSourceId,
            sourceDocumentId: "partial-document",
            caseNumber: "partial",
            country: "POL",
            court: "Fixture",
            language: "pl",
            fulltext: "Decision text",
          });
          const scope = { first: "0000", last: "2026", expectedSlices: 2 };
          const options = {
            sourceId,
            leaseToken,
            adapterKey: "cz-ns",
            slice: "2026",
            scope,
            identities: Array.from({ length: 1000 }, (_, index) => ({
              type: "document" as const,
              sourceDocumentId: `threshold-${index + 1}`,
            })),
            listed: 1000,
            publisherCount: 1000,
            observedAt,
          };
          await recordCompletenessCensus(scopedDb, {
            ...options,
            slice: "0000",
            identities: [],
            listed: 0,
            publisherCount: 0,
          });
          await recordCompletenessCensus(scopedDb, options);
          const read = async () => {
            const rows = await readCompletenessCensusQuery(db, [
              { id: sourceId, scope },
            ]);
            return (
              rows.get(String(sourceId)) ?? panic("Threshold census is absent")
            );
          };
          expect(await read()).toMatchObject({
            verdict: "incomplete",
            measuredSlices: 2,
            publisher: 1000,
            stored: 1000,
            withText: 998,
            shortSlices: 1,
          });
          const undated = await db
            .select({
              slice: caseLawCompletenessCensus.slice,
              year: caseLawCompletenessCensus.year,
            })
            .from(caseLawCompletenessCensus)
            .where(eq(caseLawCompletenessCensus.slice, "0000"));
          expect(undated).toEqual([{ slice: "0000", year: null }]);
          expect((await read()).years).toEqual([
            {
              year: 2026,
              slices: 1,
              publisher: 1000,
              stored: 1000,
              withText: 998,
            },
          ]);
          await db
            .update(caseLawDecisions)
            .set({ fulltext: "Recovered text" })
            .where(eq(caseLawDecisions.sourceDocumentId, "threshold-999"));
          await recordCompletenessCensus(scopedDb, {
            ...options,
            observedAt: new Date(observedAt.getTime() + 1),
          });
          expect(await read()).toMatchObject({
            verdict: "complete",
            publisher: 1000,
            stored: 1000,
            withText: 999,
            shortSlices: 0,
            worstSlices: [],
          });

          const partialOptions = {
            ...options,
            sourceId: partialSourceId,
            adapterKey: "pl-kio",
            scope: { first: "2026", last: "2026", expectedSlices: 1 },
            identities: [
              {
                type: "document" as const,
                sourceDocumentId: "partial-document",
              },
            ],
            listed: 1,
            publisherCount: 2,
          };
          await recordCompletenessCensus(scopedDb, partialOptions);
          const partialRows = await readCompletenessCensusQuery(db, [
            { id: partialSourceId, scope: partialOptions.scope },
          ]);
          expect(partialRows.get(String(partialSourceId))).toMatchObject({
            verdict: "unmeasured",
            scopeStatus: "partial-publisher",
            outcome: "publisher-count",
            publisher: 2,
            stored: 1,
            withText: 1,
            shortSlices: 1,
          });
          await recordCompletenessCensus(scopedDb, {
            ...partialOptions,
            publisherCount: undefined,
            observedAt: new Date(observedAt.getTime() + 1),
          });
          const enumeratedRows = await readCompletenessCensusQuery(db, [
            { id: partialSourceId, scope: partialOptions.scope },
          ]);
          expect(enumeratedRows.get(String(partialSourceId))).toMatchObject({
            verdict: "unmeasured",
            scopeStatus: "partial-publisher",
            outcome: "listing-enumerated",
            publisher: 1,
            stored: 1,
            withText: 1,
            shortSlices: 0,
          });
        } finally {
          await db.execute(sql`SET search_path TO public`);
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }, 120_000);

    test("a stated count below the distinct listing cannot hide a missing decision", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("Postgres census test requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const sourceId = createSafeId<"caseLawSource">();
        const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
        const scope = { first: "2026", last: "2026", expectedSlices: 1 };
        await db.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: "cz-ns",
          name: "Contradictory publisher count fixture",
          ingestionLeaseToken: leaseToken,
          ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
        });
        try {
          await db.insert(caseLawDecisions).values({
            sourceId,
            sourceDocumentId: "held",
            caseNumber: "held",
            country: "CZE",
            court: "Fixture",
            language: "cs",
            fulltext: "Decision text",
          });
          const scopedDb: ScopedDb = async (callback) =>
            await db.transaction(callback);
          // The listing has two distinct identities; only one is held with text.
          // Counts below, equal to and above the listing must all retain the gap.
          for (const publisherCount of [1, 0, 2, 3, undefined]) {
            await recordCompletenessCensus(scopedDb, {
              sourceId,
              leaseToken,
              adapterKey: "cz-ns",
              slice: "2026",
              scope,
              identities: [
                { type: "document", sourceDocumentId: "held" },
                { type: "document", sourceDocumentId: "missing" },
              ],
              listed: 2,
              publisherCount,
              observedAt: new Date("2026-10-16T12:00:00Z"),
            });
            const rows = await readCompletenessCensusQuery(db, [
              { id: sourceId, scope },
            ]);
            expect(rows.get(String(sourceId))).toMatchObject({
              verdict: "incomplete",
              publisher: publisherCount === 3 ? 3 : 2,
              stored: 1,
              withText: 1,
              shortSlices: 1,
              worstSlices: [{ slice: "2026", stored: 1, withText: 1 }],
            });
            expect(countryCensusVerdict([...rows.values()])).toBe("incomplete");
          }
        } finally {
          await db
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, sourceId));
        }
      });
    }, 120_000);

    test("the registered adapter scope advances at the current publisher year boundary without observing it", async () => {
      const id = createSafeId<"caseLawSource">();
      const sources = [{ id, adapterKey: "cz-us" }];
      const initial = (
        await currentCensusSourceScopes(
          sources,
          new Date("2026-12-31T23:59:59Z"),
        )
      ).at(0);
      const current = (
        await currentCensusSourceScopes(
          sources,
          new Date("2027-01-01T00:00:00Z"),
        )
      ).at(0);
      if (
        initial?.scope === null ||
        initial?.scope === undefined ||
        current?.scope === null ||
        current?.scope === undefined
      ) {
        panic("Registered publisher walk must expose its current census scope");
      }
      expect(initial.id).toBe(id);
      expect(current.id).toBe(id);
      expect(initial.scope.last).toBe("2026");
      expect(current.scope.last).toBe("2027");
      expect(current.scope.first).toBe(initial.scope.first);
      expect(current.scope.expectedSlices).toBe(
        initial.scope.expectedSlices + 1,
      );
    });

    test.each(["day", "month", "year"] as const)(
      "a new %s slice invalidates a complete census before another observation is written",
      async (unit) => {
        const databaseUrl =
          process.env["DATABASE_URL"] ??
          panic("Postgres census test requires DATABASE_URL");
        const observedAt = new Date("2026-12-31T23:59:59Z");
        const nextInstant = new Date("2027-01-01T00:00:00Z");
        const walk = (() => {
          switch (unit) {
            case "day":
              return {
                firstSlice: "2026-12-30",
                tipWindowDays: 1,
                ...createCalendarDaySliceWalk({
                  firstSlice: "2026-12-30",
                  source: "cz-ns",
                }).walk,
              };
            case "month":
              return {
                firstSlice: "2026-11",
                tipWindowDays: 1,
                sliceOf: (now: Date) => now.toISOString().slice(0, 7),
                nextSlice: (slice: string) =>
                  Temporal.PlainYearMonth.from(slice)
                    .add({ months: 1 })
                    .toString(),
                previousSlice: (slice: string) =>
                  slice === "2026-11"
                    ? null
                    : Temporal.PlainYearMonth.from(slice)
                        .subtract({ months: 1 })
                        .toString(),
              };
            case "year":
              return {
                firstSlice: "2025",
                tipWindowDays: 1,
                sliceOf: (now: Date) => String(now.getUTCFullYear()),
                nextSlice: (slice: string) => String(Number(slice) + 1),
                previousSlice: (slice: string) =>
                  slice === "2025" ? null : String(Number(slice) - 1),
              };
            default: {
              const exhaustive: never = unit;
              return exhaustive;
            }
          }
        })() satisfies SourceSliceWalk;
        const initialScope = censusScope(walk, observedAt);
        expect(initialScope.expectedSlices).toBe(2);
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const sourceId = createSafeId<"caseLawSource">();
          const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
          await db.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: `census-boundary-${sourceId}`,
            name: "Calendar scope boundary fixture",
            ingestionLeaseToken: leaseToken,
            ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
          });
          try {
            const scopedDb: ScopedDb = async (callback) =>
              await db.transaction(callback);
            for (const slice of [initialScope.first, initialScope.last]) {
              await recordCompletenessCensus(scopedDb, {
                sourceId,
                leaseToken,
                adapterKey: "cz-ns",
                slice,
                scope: initialScope,
                identities: [],
                listed: 0,
                publisherCount: 0,
                observedAt,
              });
            }
            const initial = await readCompletenessCensusQuery(db, [
              { id: sourceId, scope: censusScope(walk, observedAt) },
            ]);
            expect(initial.get(String(sourceId))).toMatchObject({
              verdict: "complete",
              measuredSlices: 2,
              expectedSlices: 2,
            });
            const currentScope = censusScope(walk, nextInstant);
            expect(currentScope.last).not.toBe(initialScope.last);
            expect(currentScope.expectedSlices).toBe(3);
            const current = await readCompletenessCensusQuery(db, [
              { id: sourceId, scope: currentScope },
            ]);
            expect(current.get(String(sourceId))).toMatchObject({
              verdict: "unmeasured",
              measuredSlices: 2,
              expectedSlices: 3,
            });
            expect(countryCensusVerdict([...current.values()])).toBe(
              "unmeasured",
            );
            const persisted = await db
              .select()
              .from(caseLawCompletenessCensus)
              .where(eq(caseLawCompletenessCensus.sourceId, sourceId));
            expect(persisted).toHaveLength(2);
            expect(
              persisted.every(
                (row) => row.observedAt.getTime() === observedAt.getTime(),
              ),
            ).toBe(true);
          } finally {
            await db
              .delete(caseLawSources)
              .where(eq(caseLawSources.id, sourceId));
          }
        });
      },
      120_000,
    );

    test("the migrated public reader sees allowed census observations and rejects the previous grant map", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("Postgres census test requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const visible = createSafeId<"caseLawSource">();
        const withheld = createSafeId<"caseLawSource">();
        await db.insert(caseLawSources).values([
          {
            id: visible,
            adapterKey: `census-visible-${visible}`,
            name: "Visible census fixture",
          },
          {
            id: withheld,
            adapterKey: `census-withheld-${withheld}`,
            name: "Withheld census fixture",
            descriptor: {
              license: "restricted",
              attribution: "Fixture",
              allowsRedistribution: false,
              allowsDerivedAi: false,
            },
          },
        ]);
        try {
          await db.insert(caseLawCompletenessCensus).values(
            [visible, withheld].map((sourceId) => ({
              sourceId,
              slice: "2026",
              year: 2026,
              outcome: "publisher-count" as const,
              scopeStatus: "full-publisher" as const,
              publisherCount: 1,
              storedCount: 1,
              textCount: 1,
              observedAt: new Date("2026-10-16T12:00:00Z"),
              scopeFirst: "2026",
              scopeLast: "2026",
              expectedSlices: 1,
              evidenceRef: "fixture",
            })),
          );
          await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
            const rows = await readCompletenessCensusQuery(tx, [
              {
                id: visible,
                scope: { first: "2026", last: "2026", expectedSlices: 1 },
              },
              {
                id: withheld,
                scope: { first: "2026", last: "2026", expectedSlices: 1 },
              },
            ]);
            expect(rows.get(String(visible))).toMatchObject({
              verdict: "complete",
              publisher: 1,
              stored: 1,
              withText: 1,
            });
            expect(rows.has(String(withheld))).toBe(false);
            const current = await tx.execute(
              publicLawDatabaseRolePermissionsSql(),
            );
            expect(current.at(0)?.["canReadOtherData"]).toBe(false);
            const previousMap = Object.fromEntries(
              Object.entries(PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION).filter(
                ([relation]) => relation !== "case_law_completeness_census",
              ),
            );
            const previous = await tx.execute(
              publicLawDatabaseRolePermissionsSql(previousMap),
            );
            expect(previous.at(0)?.["canReadOtherData"]).toBe(true);
          });
        } finally {
          await db
            .delete(caseLawSources)
            .where(sql`${caseLawSources.id} IN (${visible}, ${withheld})`);
        }
      });
    }, 120_000);

    test("replays converge, text and slice gaps gate the persisted verdict, and stale leases cannot write", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("Postgres census test requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const schema = sql.identifier(
          `census_${Bun.randomUUIDv7().replaceAll("-", "")}`,
        );
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of [
            "case_law_sources",
            "case_law_decisions",
            "case_law_completeness_census",
          ]) {
            await db.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await db.execute(sql`SET search_path TO ${schema}, public`);
          const scopedDb: ScopedDb = async (callback) =>
            await db.transaction(callback);
          const sourceId = createSafeId<"caseLawSource">();
          const unknownSourceId = createSafeId<"caseLawSource">();
          const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
          const observedAt = new Date("2026-10-16T12:00:00Z");
          await db.insert(caseLawSources).values([
            {
              id: sourceId,
              adapterKey: "cz-ns",
              name: "Census fixture",
              ingestionLeaseToken: leaseToken,
              ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
            },
            {
              id: unknownSourceId,
              adapterKey: "pl-nsa",
              name: "Unmeasured fixture",
              ingestionLeaseToken: leaseToken,
              ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
            },
          ]);
          await db.insert(caseLawDecisions).values([
            {
              sourceId,
              sourceDocumentId: "has-text",
              caseNumber: "text",
              country: "CZE",
              court: "Fixture",
              language: "cs",
              fulltext: "Decision text",
            },
            {
              sourceId,
              caseNumber: "empty",
              country: "CZE",
              court: "Fixture",
              language: "cs",
              fulltext: "",
            },
          ]);
          const identities = [
            { type: "document", sourceDocumentId: "has-text" },
            { type: "case-number", caseNumber: "empty", language: "cs" },
            { type: "document", sourceDocumentId: "missing" },
          ] satisfies ListingIdentity[];
          const options = {
            sourceId,
            leaseToken,
            adapterKey: "cz-ns",
            slice: "2026",
            scope: { first: "2026", last: "2026", expectedSlices: 1 },
            identities,
            listed: 3,
            publisherCount: 3,
            observedAt,
          };
          let currentScope = options.scope;
          const read = async () => {
            const observations = await readCompletenessCensusQuery(db, [
              { id: sourceId, scope: currentScope },
              { id: unknownSourceId, scope: null },
            ]);
            return (
              observations.get(String(sourceId)) ??
              panic("Persisted census is absent")
            );
          };
          await recordCompletenessCensus(scopedDb, options);
          await recordCompletenessCensus(scopedDb, options);
          expect(
            await db.select().from(caseLawCompletenessCensus),
          ).toHaveLength(1);
          expect(await read()).toMatchObject({
            verdict: "incomplete",
            stored: 2,
            withText: 1,
            publisher: 3,
            shortSlices: 1,
          });
          expect((await read()).worstSlices.at(0)).toMatchObject({
            slice: "2026",
            stored: 2,
            withText: 1,
          });

          await db
            .update(caseLawDecisions)
            .set({ fulltext: "Recovered text" })
            .where(eq(caseLawDecisions.caseNumber, "empty"));
          const complete = {
            ...options,
            identities: identities.slice(0, 2),
            listed: 2,
            publisherCount: 2,
            observedAt: new Date(observedAt.getTime() + 1),
          };
          await recordCompletenessCensus(scopedDb, complete);
          expect(await read()).toMatchObject({
            verdict: "complete",
            stored: 2,
            withText: 2,
            publisher: 2,
            worstSlices: [],
          });
          await recordCompletenessCensus(scopedDb, options);
          expect(await read()).toMatchObject({
            verdict: "complete",
            publisher: 2,
          });

          const scope = { first: "2025", last: "2026", expectedSlices: 2 };
          currentScope = scope;
          await recordCompletenessCensus(scopedDb, {
            ...complete,
            scope,
            observedAt: new Date(observedAt.getTime() + 2),
          });
          expect(await read()).toMatchObject({
            verdict: "unmeasured",
            measuredSlices: 1,
            expectedSlices: 2,
          });
          await recordCompletenessCensus(scopedDb, {
            ...complete,
            scope,
            slice: "2025",
            identities: [],
            listed: 0,
            publisherCount: undefined,
          });
          expect(await read()).toMatchObject({
            verdict: "complete",
            measuredSlices: 2,
            expectedSlices: 2,
            outcome: "listing-enumerated",
          });

          await recordCompletenessCensus(scopedDb, {
            ...options,
            leaseToken: createSafeId<"caseLawSourceIngestionLease">(),
            publisherCount: 999,
            observedAt: new Date(observedAt.getTime() + 3),
          });
          expect(await read()).toMatchObject({
            verdict: "complete",
            publisher: 2,
          });
          await db
            .update(caseLawSources)
            .set({ ingestionLeaseExpiresAt: new Date(0) })
            .where(eq(caseLawSources.id, sourceId));
          await recordCompletenessCensus(scopedDb, {
            ...options,
            publisherCount: 999,
            observedAt: new Date(observedAt.getTime() + 4),
          });
          expect(await read()).toMatchObject({
            verdict: "complete",
            publisher: 2,
          });

          await recordCompletenessCensus(scopedDb, {
            ...options,
            sourceId: unknownSourceId,
            adapterKey: "pl-nsa",
            identities: [],
            listed: 0,
            publisherCount: undefined,
          });
          const countrySources = await readCompletenessCensusQuery(db, [
            { id: sourceId, scope: currentScope },
            { id: unknownSourceId, scope: null },
          ]);
          expect(countrySources.get(String(unknownSourceId))).toMatchObject({
            verdict: "unmeasured",
            outcome: "none-exposed",
            publisher: null,
          });
          expect(countryCensusVerdict([...countrySources.values()])).toBe(
            "unmeasured",
          );
        } finally {
          await db.execute(sql`SET search_path TO public`);
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }, 120_000);
  },
);
