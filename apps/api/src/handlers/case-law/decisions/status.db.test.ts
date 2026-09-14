import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { readCaseLawCorpusStatusQuery } from "@/api/handlers/case-law/decisions/status";
import { readCaseLawCourtActivityQuery } from "@/api/handlers/case-law/decisions/status-courts";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The timestamp beside the search box is the newest decision the public
 * surface may show: newest of the country rather than of the corpus, of an
 * admitted source rather than of any, and unknown when nothing qualifies.
 */

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("CZE is a public case-law country");

const openSourceId = createSafeId<"caseLawSource">();
const restrictedSourceId = createSafeId<"caseLawSource">();

const NEWEST_OPEN = "2026-03-04T05:06:07.000Z";
const APEX_COURT = "Útavní soud";
const REGIONAL_COURT = "Krajský soud v Brně";
/** Where the activity windows are measured back from, so the fixtures are stable. */
const ACTIVITY_NOW = new Date("2026-01-02T18:00:00.000Z");
const APEX_UPDATED_AT = "2026-01-05T00:00:00.000Z";
const NEWEST_RESTRICTED = "2026-06-07T08:09:10.000Z";

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

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

    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: "open",
        id: openSourceId,
        name: "open",
      }),
      caseLawSourceRow({
        adapterKey: "restricted",
        id: restrictedSourceId,
        name: "restricted",
      }),
    ]);
    // Oldest first, so a read that answers with a row rather than with the
    // newest row cannot pass by luck of the insertion order.
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "oldest",
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: openSourceId,
        updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      },
      {
        caseNumber: "another country, newer still",
        country: "SVK",
        court: "Court",
        language: "sk",
        sourceId: openSourceId,
        updatedAt: new Date("2026-09-10T11:12:13.000Z"),
      },
      {
        caseNumber: "newest open",
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: openSourceId,
        updatedAt: new Date(NEWEST_OPEN),
      },
      {
        caseNumber: "newest restricted",
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: restrictedSourceId,
        updatedAt: new Date(NEWEST_RESTRICTED),
      },
      // The per-court breakdown's fixtures. Their timestamps sit in January so
      // the windows the activity read is given (`ACTIVITY_NOW`) select them
      // without disturbing what the corpus-wide reads above report.
      {
        caseNumber: "apex, ingested inside the day",
        country: "CZE",
        court: APEX_COURT,
        createdAt: new Date("2026-01-02T12:00:00.000Z"),
        language: "cs",
        sourceId: openSourceId,
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
      },
      {
        // Ingested before the day, revised after it: the counts read the
        // ingestion stamp, the "last updated" column reads the revision.
        caseNumber: "apex, ingested inside the week",
        country: "CZE",
        court: APEX_COURT,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        language: "cs",
        sourceId: openSourceId,
        updatedAt: new Date(APEX_UPDATED_AT),
      },
      {
        caseNumber: "regional, withheld source",
        country: "CZE",
        court: REGIONAL_COURT,
        createdAt: new Date("2026-01-02T12:00:00.000Z"),
        language: "cs",
        sourceId: restrictedSourceId,
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

/** The instant the read reported, so the serialized offset is not the subject. */
const readUpdatedAt = async (
  excludedSourceIds: readonly SafeId<"caseLawSource">[],
) => {
  const updatedAt = await caseLawDb(
    async (tx) =>
      await readCaseLawCorpusStatusQuery(tx, {
        country: COUNTRY,
        excludedSourceIds,
      }),
  );
  return updatedAt === null ? null : new Date(updatedAt).toISOString();
};

test(
  "reports the newest decision of its country, not of the corpus",
  async () => {
    expect(await readUpdatedAt([])).toBe(NEWEST_RESTRICTED);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "skips an excluded source's newer decision",
  async () => {
    expect(await readUpdatedAt([restrictedSourceId])).toBe(NEWEST_OPEN);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "reports nothing when no decision is admitted",
  async () => {
    expect(await readUpdatedAt([openSourceId, restrictedSourceId])).toBeNull();
  },
  DB_TEST_TIMEOUT_MS,
);

/** The statement budget the transaction is currently under. */
const readStatementTimeout = async (
  tx: CaseLawPublicReadTransaction,
): Promise<string | null> => {
  const result = await tx.execute(
    sql`SELECT current_setting('statement_timeout') AS statement_timeout`,
  );
  const rows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown }).rows;
  const row: unknown = Array.isArray(rows) ? rows.at(0) : undefined;
  const value =
    typeof row === "object" && row !== null && "statement_timeout" in row
      ? Reflect.get(row, "statement_timeout")
      : undefined;
  return typeof value === "string" ? value : null;
};

/** The per-court activity behind the corpus-status popover's breakdown. */
const readActivity = async (
  excludedSourceIds: readonly SafeId<"caseLawSource">[],
) =>
  await caseLawDb(
    async (tx) =>
      await readCaseLawCourtActivityQuery(tx, {
        country: COUNTRY,
        courts: [APEX_COURT, REGIONAL_COURT],
        excludedSourceIds,
        now: ACTIVITY_NOW,
      }),
  );

test(
  "counts what each court gained in each window and when it last changed",
  async () => {
    const activity = await readActivity([]);

    // One of the two arrived inside the day; both arrived inside the week.
    expect(activity.get(APEX_COURT)?.addedLastDay).toBe(1);
    expect(activity.get(APEX_COURT)?.addedLastWeek).toBe(2);
    expect(
      new Date(activity.get(APEX_COURT)?.updatedAt ?? "").toISOString(),
    ).toBe(APEX_UPDATED_AT);
    expect(activity.get(REGIONAL_COURT)?.addedLastDay).toBe(1);
    expect(activity.get(REGIONAL_COURT)?.addedLastWeek).toBe(1);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a withheld source leaves its court with nothing to report",
  async () => {
    const activity = await readActivity([restrictedSourceId]);

    expect(activity.get(APEX_COURT)?.addedLastWeek).toBe(2);
    // The court keeps its row: a court the policy empties is still a court the
    // facets named, and dropping the row would read as a court that vanished.
    expect(activity.get(REGIONAL_COURT)).toEqual({
      addedLastDay: 0,
      addedLastWeek: 0,
      updatedAt: null,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "bounds its own statement and hands the transaction's budget back",
  async () => {
    // The breakdown rides a bound well under the reader's critical-query
    // timeout, so a cold or missing index degrades the popover instead of
    // stalling the status response behind the transaction's 30 s guard. The
    // transaction is shared with other reads, so the bound is this read's
    // alone.
    const budgets = await caseLawDb(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', '30s', true)`,
      );
      const before = await readStatementTimeout(tx);
      await readCaseLawCourtActivityQuery(tx, {
        country: COUNTRY,
        courts: [APEX_COURT],
        excludedSourceIds: [],
        now: ACTIVITY_NOW,
      });
      return { after: await readStatementTimeout(tx), before };
    });

    expect(budgets.before).toBe("30s");
    expect(budgets.after).toBe("30s");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a court the corpus holds nothing of reports nothing",
  async () => {
    const unheld = "Soud, ktery neexistuje";
    const activity = await caseLawDb(
      async (tx) =>
        await readCaseLawCourtActivityQuery(tx, {
          country: COUNTRY,
          courts: [unheld],
          excludedSourceIds: [],
          now: ACTIVITY_NOW,
        }),
    );

    expect(activity.get(unheld)).toEqual({
      addedLastDay: 0,
      addedLastWeek: 0,
      updatedAt: null,
    });
  },
  DB_TEST_TIMEOUT_MS,
);
