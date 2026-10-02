import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawDecisions,
  caseLawReconciliationItems,
  caseLawSources,
  RECONCILIATION_ITEM_STATUS,
} from "@/api/db/schema";
import { runReconciliationWorkUnit } from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import { createSafeId } from "@/api/lib/branded-types";
import { toUtcDateString } from "@/api/lib/dates";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import type { SourceReconciliation } from "@/api/lib/legal-search/ingestion-types";
import {
  RECONCILIATION_TERMINAL_ATTEMPTS,
  resolveReconciliationItem,
} from "@/api/lib/legal-search/reconciliation-store";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const oldPayload = (id: string) => ({
  documentId: id,
  documentUrl: `https://www.ris.bka.gv.at/Dokumente/Justiz/U1-${id}.xml`,
});
const correctedPayload = (id: string) => ({
  documentId: id,
  documentUrl: `https://www.ris.bka.gv.at/Dokumente/Justiz/U2-${id}.xml`,
});
type Fixture = {
  db: GatedTestDb;
  scopedDb: ScopedDb;
  sourceId: ReturnType<typeof createSafeId<"caseLawSource">>;
  now: Date;
  slice: string;
  seed: (id: string, status: "parked" | "terminal") => Promise<void>;
  row: (
    id: string,
  ) => Promise<typeof caseLawReconciliationItems.$inferSelect | undefined>;
  walk: (
    reconciliation: SourceReconciliation,
    budget?: number,
  ) => ReturnType<typeof runReconciliationWorkUnit>;
  stale: () => Promise<void>;
};
const withFixture = async (work: (fixture: Fixture) => Promise<void>) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ??
    panic(
      "DATABASE_URL required for PostgreSQL reconciliation revision regression",
    );
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const schema = `listing_revision_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    try {
      for (const table of [
        "case_law_sources",
        "case_law_coverage_slices",
        "case_law_reconciliation_items",
        "case_law_decisions",
        "case_law_decision_supplements",
      ]) {
        // db-await-in-loop: clone migrated declarations before isolating the fixture's search path.
        await db.execute(
          sql`CREATE TABLE ${sql.identifier(schema)}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
        );
      }
      await db.execute(
        sql`SET search_path TO ${sql.identifier(schema)}, public`,
      );
      const payloadHashColumn =
        await db.execute(sql`SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'case_law_reconciliation_items'
          AND column_name = ${caseLawReconciliationItems.payloadHash.name}`);
      if (payloadHashColumn.length === 0) {
        // This migration's ALTER targets an unqualified name; search_path above owns it.
        const migration = await Bun.file(
          new URL(
            "../../../../drizzle/20261003123500_reconciliation_listing_revision/migration.sql",
            import.meta.url,
          ),
        ).text();
        await db.transaction(async (tx) => {
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim().length > 0) {
              // db-await-in-loop: exact new migration touches only the isolated cloned relation.
              await tx.execute(sql.raw(statement));
            }
          }
        });
      }
      const scopedDb: ScopedDb = async (callback) =>
        await db.transaction(async (tx) => await callback(asTestRaw(tx)));
      const sourceId = createSafeId<"caseLawSource">();
      const adapterKey = `listing-revision-${sourceId}`;
      const now = new Date();
      const slice = toUtcDateString(now);
      await db
        .insert(caseLawSources)
        .values({ id: sourceId, adapterKey, name: "Listing revision fixture" });
      await db
        .insert(caseLawCoverageSlices)
        .values({
          id: createSafeId<"caseLawCoverageSlice">(),
          sourceId,
          slice,
          reported: 0,
          collected: 0,
          checkedAt: new Date(now.getTime() - 2 * DAY_IN_MS),
        });
      const key = (id: string) =>
        listingIdentityKey({ type: "document", sourceDocumentId: id }) ??
        panic("Fixture identity must be keyable");
      await work({
        db,
        scopedDb,
        sourceId,
        now,
        slice,
        seed: async (id, status) => {
          await db.insert(caseLawReconciliationItems).values({
            id: createSafeId<"caseLawReconciliationItem">(),
            sourceId,
            slice,
            identityKey: key(id),
            payload: oldPayload(id),
            status,
            attempts:
              status === "terminal" ? RECONCILIATION_TERMINAL_ATTEMPTS : 2,
            nextAttemptAt:
              status === "terminal"
                ? null
                : new Date(now.getTime() + DAY_IN_MS),
            lastAttemptAt: new Date(now.getTime() - DAY_IN_MS),
            lastError: "The old listing detail was unavailable",
          });
        },
        row: async (id) =>
          (
            await db
              .select()
              .from(caseLawReconciliationItems)
              .where(
                and(
                  eq(caseLawReconciliationItems.sourceId, sourceId),
                  eq(caseLawReconciliationItems.identityKey, key(id)),
                ),
              )
          ).at(0),
        stale: async () => {
          await db
            .update(caseLawCoverageSlices)
            .set({ checkedAt: new Date(now.getTime() - 2 * DAY_IN_MS) })
            .where(eq(caseLawCoverageSlices.sourceId, sourceId));
        },
        walk: async (reconciliation, sliceIngestBudget = 1) =>
          await runReconciliationWorkUnit({
            adapterKey,
            sourceId,
            reconciliation,
            reparseStoredRaw: undefined,
            scopedDb,
            now: () => now,
            fetchDelayMs: 0,
            sleep: async () => {},
            sliceRetries: new Map(),
            sliceIngestBudget,
          }),
      });
    } finally {
      await db.execute(sql`SET search_path TO public`);
      await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    }
  });
};
const publisher = (
  slice: string,
  payloads: ReturnType<typeof oldPayload>[],
  attempted: unknown[],
): SourceReconciliation => ({
  firstSlice: slice,
  sliceOf: toUtcDateString,
  tipWindowDays: 1,
  nextSlice: () => null,
  previousSlice: () => null,
  listSlicePage: async () => ({
    items: payloads.map((payload) => ({
      identity: { type: "document", sourceDocumentId: payload.documentId },
      payload,
    })),
    totalPages: 1,
  }),
  buildDecision: async (payload) => {
    attempted.push(payload);
    return { type: "detail-unavailable" };
  },
});

describe.skipIf(!enabled)(
  "reconciliation listing revisions on PostgreSQL",
  () => {
    for (const status of ["parked", "terminal"] as const) {
      test(`a completed walk reopens a corrected ${status} identity and retries U2`, async () => {
        await withFixture(async (fixture) => {
          const id = "JFT_20260901_26R00001";
          await fixture.seed(id, status);
          const attempted: unknown[] = [];
          const reconciliation = publisher(
            fixture.slice,
            [correctedPayload(id)],
            attempted,
          );
          expect(await fixture.walk(reconciliation)).toMatchObject({
            type: "worked",
            summary: { slice: fixture.slice, keyable: 1 },
          });
          const tracked = await fixture.row(id);
          expect(tracked?.payload).toEqual(correctedPayload(id));
          expect(tracked?.status).toBe(RECONCILIATION_ITEM_STATUS.PARKED);
          expect(tracked?.attempts).toBeLessThan(
            RECONCILIATION_TERMINAL_ATTEMPTS,
          );
          if (
            !attempted.some(
              (payload) =>
                JSON.stringify(payload) ===
                JSON.stringify(correctedPayload(id)),
            )
          ) {
            expect(tracked).toMatchObject({
              attempts: 0,
              lastAttemptAt: null,
              lastError: null,
            });
            expect(tracked?.nextAttemptAt?.getTime()).toBeLessThanOrEqual(
              fixture.now.getTime(),
            );
            await fixture.walk(reconciliation);
          }
          expect(attempted).toContainEqual(correctedPayload(id));
          expect(attempted).not.toContainEqual(oldPayload(id));
        });
      }, 60_000);
      test(`identical listings preserve the ${status} disposition and retry schedule`, async () => {
        await withFixture(async (fixture) => {
          const id = "JFT_20260901_26R00002";
          await fixture.seed(id, status);
          const before = await fixture.row(id);
          const attempted: unknown[] = [];
          const reconciliation = publisher(
            fixture.slice,
            [oldPayload(id)],
            attempted,
          );
          await fixture.walk(reconciliation);
          const first = await fixture.row(id);
          await fixture.stale();
          await fixture.walk(reconciliation);
          const second = await fixture.row(id);
          for (const row of [first, second]) {
            expect(row).toMatchObject({
              payload: before?.payload,
              status,
              attempts: before?.attempts,
              nextAttemptAt: before?.nextAttemptAt,
              lastAttemptAt: before?.lastAttemptAt,
              lastError: before?.lastError,
            });
          }
          expect(attempted).toEqual([]);
        });
      }, 60_000);
    }
    test("a correction beyond the build budget remains parked and due rather than terminal", async () => {
      await withFixture(async (fixture) => {
        const ids = ["JFT_20260901_26R00003", "JFT_20260901_26R00004"];
        for (const id of ids) {
          await fixture.seed(id, "terminal");
        }
        const attempted: unknown[] = [];
        const reconciliation = publisher(
          fixture.slice,
          ids.map(correctedPayload),
          attempted,
        );
        await fixture.walk(reconciliation, 1);
        for (const id of ids) {
          const tracked = await fixture.row(id);
          expect(tracked?.payload).toEqual(correctedPayload(id));
          expect(tracked?.status).toBe(RECONCILIATION_ITEM_STATUS.PARKED);
          expect(tracked?.attempts).toBeLessThan(
            RECONCILIATION_TERMINAL_ATTEMPTS,
          );
          if (
            !attempted.some(
              (payload) =>
                JSON.stringify(payload) ===
                JSON.stringify(correctedPayload(id)),
            )
          ) {
            expect(tracked).toMatchObject({
              attempts: 0,
              lastAttemptAt: null,
              lastError: null,
            });
            expect(tracked?.nextAttemptAt?.getTime()).toBeLessThanOrEqual(
              fixture.now.getTime(),
            );
          }
        }
        expect(attempted.length).toBeLessThanOrEqual(1);
      });
    }, 60_000);
    test("a stale corrected-revision worker cannot repark an identity materialized by the next crawl owner", async () => {
      await withFixture(async (fixture) => {
        const id = "JFT_20260901_26R00005";
        await fixture.seed(id, "parked");
        const attempted: unknown[] = [];
        const reconciliation = publisher(
          fixture.slice,
          [correctedPayload(id)],
          attempted,
        );
        await fixture.walk(reconciliation);
        expect((await fixture.row(id))?.payload).toEqual(correctedPayload(id));
        const fetching = Promise.withResolvers<undefined>();
        const finishFetch = Promise.withResolvers<undefined>();
        const staleRun = Result.tryPromise({
          try: async () =>
            await fixture.walk({
              ...reconciliation,
              buildDecision: async (payload) => {
                expect(payload).toEqual(correctedPayload(id));
                fetching.resolve(undefined);
                await finishFetch.promise;
                return { type: "detail-unavailable" };
              },
            }),
          catch: (cause) => cause,
        });
        await fetching.promise;
        await fixture.db
          .update(caseLawSources)
          .set({ ingestionLeaseExpiresAt: new Date(0) })
          .where(eq(caseLawSources.id, fixture.sourceId));
        const crawlLease = await acquireCaseLawSourceIngestionLease({
          scopedDb: fixture.scopedDb,
          sourceId: fixture.sourceId,
        });
        if (crawlLease === null) {
          finishFetch.resolve(undefined);
          await staleRun;
          return panic("The next crawl must acquire the expired source lease");
        }
        try {
          try {
            await crawlLease.beforeDatabaseMark();
            await fixture.db.insert(caseLawDecisions).values({
              id: createSafeId<"caseLawDecision">(),
              sourceId: fixture.sourceId,
              sourceDocumentId: id,
              caseNumber: "26 R 1/26",
              country: "AUT",
              court: "Court",
              language: "de",
              fulltext: "The corrected publisher document is materialized.",
              sourceUrl: correctedPayload(id).documentUrl,
            });
            const resolved = await resolveReconciliationItem(fixture.scopedDb, {
              sourceId: fixture.sourceId,
              leaseToken: crawlLease.leaseToken,
              identityKey:
                listingIdentityKey({
                  type: "document",
                  sourceDocumentId: id,
                }) ?? panic("Missing identity key"),
              payload: correctedPayload(id),
            });
            expect(resolved.outcome).toBe("recorded");
            expect(await fixture.row(id)).toBeUndefined();
          } finally {
            finishFetch.resolve(undefined);
          }
          const stale = await staleRun;
          expect(stale.isErr()).toBe(true);
          if (stale.isOk()) {
            return panic("A stale worker must reject its lost source lease");
          }
          expect(stale.error).toBeInstanceOf(ConcurrentModificationError);
          expect(await fixture.row(id)).toBeUndefined();
          const held = (
            await fixture.db
              .select({
                sourceUrl: caseLawDecisions.sourceUrl,
                fulltext: caseLawDecisions.fulltext,
              })
              .from(caseLawDecisions)
              .where(
                and(
                  eq(caseLawDecisions.sourceId, fixture.sourceId),
                  eq(caseLawDecisions.sourceDocumentId, id),
                ),
              )
          ).at(0);
          expect(held).toEqual({
            sourceUrl: correctedPayload(id).documentUrl,
            fulltext: "The corrected publisher document is materialized.",
          });
        } finally {
          await crawlLease.release();
        }
      });
    }, 60_000);
  },
);
