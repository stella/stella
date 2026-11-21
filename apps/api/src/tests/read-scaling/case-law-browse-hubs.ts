import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import readBrowseCalendar, {
  type createBrowseCalendarRoute,
} from "@/api/handlers/case-law/decisions/browse-calendar";
import listBrowseCourts, {
  type createBrowseCourtsRoute,
} from "@/api/handlers/case-law/decisions/browse-courts";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  caseLawPublishedDecisionsFixtureSql,
  caseLawUnredactedDecisionsFixtureSql,
} from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The browse tree's reads stay the same size while the corpus around the
 * requested court grows: the growth lands in another court (calendar) or
 * another jurisdiction (courts), and the answer, its statements and its bytes
 * do not move.
 */

const OPEN_DESCRIPTOR = {
  license: "public-domain",
  attribution: null,
  allowsRedistribution: true,
  allowsDerivedAi: true,
} as const;

const temporaryTables = async (db: GatedTestDb, tables: readonly string[]) => {
  for (const table of tables) {
    // db-await-in-loop: a fixed list of at most three temp tables, created in order
    await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} (
      LIKE public.${sql.identifier(table)} INCLUDING DEFAULTS
    )`);
  }
};

const readDbOver = (db: GatedTestDb) =>
  asTestRaw<CaseLawPublicReadDb>(
    async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await db.transaction(async (tx) => await read(asTestRaw(tx))),
  );

const requestFor = (path: string, query: Record<string, unknown>) => ({
  query,
  request: new Request(`https://example.test${path}`),
  route: path,
  set: { headers: {} },
});

type CalendarMeasurementOptions = {
  size: number;
  db: GatedTestDb;
  createHandler: typeof createBrowseCalendarRoute;
};

export const browseCalendarScalingScenario = {
  name: "public case-law browse calendar",
  definition: readBrowseCalendar,
  measure: async ({ size, db, createHandler }: CalendarMeasurementOptions) => {
    await temporaryTables(db, ["case_law_sources", "case_law_decisions"]);
    await db.execute(caseLawPublishedDecisionsFixtureSql);
    await db.execute(caseLawUnredactedDecisionsFixtureSql);
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "browse-calendar-scaling",
      name: "Browse calendar fixture",
      descriptor: OPEN_DESCRIPTOR,
    });
    const decision = (court: string, index: number) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `${court} ${String(index)}`,
      court,
      country: "CZE",
      language: "cs",
      decisionDate: "2025-03-10",
      fulltext: "Published decision",
      metadata: {},
    });
    await db
      .insert(caseLawDecisions)
      .values([
        decision("Krajský soud v Brně", 0),
        ...Array.from({ length: size }, (_, index) =>
          decision("Nejvyšší soud", index),
        ),
      ]);
    const route = createHandler(readDbOver(db));
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await route.handler(
        asTestRaw<Parameters<typeof route.handler>[0]>(
          requestFor("/v1/case/browse/calendar", {
            country: "CZE",
            court: "Krajský soud v Brně",
            year: "2025",
          }),
        ),
      );
      if (response instanceof HttpStatusResponse) {
        return panic("Browse calendar scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.periods.length,
      };
    });
  },
};

type CourtsMeasurementOptions = {
  size: number;
  db: GatedTestDb;
  createHandler: typeof createBrowseCourtsRoute;
};

export const browseCourtsScalingScenario = {
  name: "public case-law browse courts",
  definition: listBrowseCourts,
  measure: async ({ size, db, createHandler }: CourtsMeasurementOptions) => {
    await temporaryTables(db, [
      "case_law_sources",
      "case_law_population_counts",
    ]);
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "browse-courts-scaling",
      name: "Browse courts fixture",
      descriptor: OPEN_DESCRIPTOR,
    });
    // Three courts in the requested jurisdiction; the growth is elsewhere.
    await db.execute(sql`INSERT INTO case_law_population_counts
      (kind, country, source_id, value, total)
      SELECT 'court', 'CZE', ${sourceId}::uuid, 'Soud ' || n::text, 1
      FROM generate_series(1, 3) n`);
    await db.execute(sql`INSERT INTO case_law_population_counts
      (kind, country, source_id, value, total)
      SELECT 'court', 'SVK', ${sourceId}::uuid, 'Súd ' || lpad(n::text, 5, '0'), 1
      FROM generate_series(1, ${size}) n`);
    const route = createHandler(readDbOver(db));
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await route.handler(
        asTestRaw<Parameters<typeof route.handler>[0]>(
          requestFor("/v1/case/browse/courts", { country: "CZE" }),
        ),
      );
      if (response instanceof HttpStatusResponse) {
        return panic("Browse courts scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.courts.length,
      };
    });
  },
};
