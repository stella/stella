import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { readBrowseCalendarHandler } from "@/api/handlers/case-law/decisions/browse-hubs";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The browse calendar names exactly the periods that hold a court's
 * decisions, and counts each only up to one past what a listing pages, so a
 * month too large for one listing reads as split however large it is.
 */

const DB_TEST_TIMEOUT_MS = 120_000;
const COURT = "Nejvyšší soud";
const OTHER_COURT = "Ústavní soud";
const sourceId = createSafeId<"caseLawSource">();
const CAP = LIMITS.caseLawBrowseListingDepth + 1;
/** A busy day: more decisions than one listing pages. */
const BUSY = LIMITS.caseLawBrowseListingDepth + 20;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const decision = (court: string, decisionDate: string | null, index = 0) => ({
  caseNumber: `${court} ${decisionDate ?? "undated"} ${String(index)}`,
  country: "CZE",
  court,
  decisionDate,
  language: "cs",
  sourceId,
});

// timeout: an embedded Postgres pushes the whole schema before the seed.
beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the read uses.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the read never inspects the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db
      .insert(caseLawSources)
      .values([
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    await db.insert(caseLawDecisions).values([
      decision(COURT, "1999-12-31"),
      decision(COURT, "2021-03-04"),
      decision(COURT, "2021-03-05"),
      decision(COURT, "2021-11-30"),
      decision(COURT, null),
      ...Array.from({ length: BUSY }, (_, index) =>
        decision(COURT, "2023-05-17", index),
      ),
      decision(COURT, "2023-05-18"),
      // Another court's decisions never show in this court's calendar.
      decision(OTHER_COURT, "2022-01-01"),
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const read = async (query: { year?: number; month?: number }) =>
  await readBrowseCalendarHandler(
    { country: "CZE", court: COURT, ...query },
    caseLawDb,
  );

// timeout: each read runs on an embedded Postgres.
test(
  "a court's years skip the empty ones and report its undated decisions",
  async () => {
    expect(await read({})).toEqual({
      level: "years",
      periods: [
        { value: 1999, count: 0 },
        { value: 2021, count: 0 },
        { value: 2023, count: 0 },
      ],
      undated: 1,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: each read runs on an embedded Postgres.
test(
  "a year's months carry counts, capped one past the listing depth",
  async () => {
    expect(await read({ year: 2021 })).toEqual({
      level: "months",
      periods: [
        { value: 3, count: 2 },
        { value: 11, count: 1 },
      ],
      undated: 0,
    });
    expect(await read({ year: 2023 })).toEqual({
      level: "months",
      periods: [{ value: 5, count: CAP }],
      undated: 0,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: each read runs on an embedded Postgres.
test(
  "a split month's days carry their own capped counts",
  async () => {
    expect(await read({ year: 2023, month: 5 })).toEqual({
      level: "days",
      periods: [
        { value: 17, count: CAP },
        { value: 18, count: 1 },
      ],
      undated: 0,
    });
  },
  DB_TEST_TIMEOUT_MS,
);
