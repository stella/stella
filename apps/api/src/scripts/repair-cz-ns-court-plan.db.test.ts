/**
 * The repair's two halves against a real PostgreSQL: the walk, which decides
 * which stored rows are looked at at all, and the write, which decides what a
 * looked-at row becomes. Neither is exercised anywhere else — an operator
 * script's SQL is never executed by CI — and a walk that reads the wrong
 * population is a repair that rewrites decisions nobody asked it to.
 *
 * The source fixture is deliberately larger than a page. The fault this walk
 * was rebuilt for only appears at scale: a selection bounded by matches reads
 * to the end of a source looking for rows that are not there, which a handful
 * of fixtures can never show.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  applyCzNsCourtRepairStatement,
  CZ_NS_COURT_REPAIR_OUTCOMES,
  czNsSourceIdStatement,
  decideCzNsCourtRepair,
  parseCzNsCourtPage,
  parseCzNsSourceId,
  selectCzNsCourtPageStatement,
} from "@/api/scripts/repair-cz-ns-court-plan";
import type {
  CzNsCourtCursor,
  CzNsCourtPage,
  CzNsCourtRow,
} from "@/api/scripts/repair-cz-ns-court-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const nsSourceId = createSafeId<"caseLawSource">();
const nssSourceId = createSafeId<"caseLawSource">();

const PUBLISHER_COURT = "Nejvyšší soud";
const PUBLISHER_ECLI_CODE = "NS";

/** When the fixtures were last written, long before any run of the repair. */
const STORED_AT = new Date("2020-01-01T00:00:00.000Z");

/** Rows the source holds. Several pages' worth at the size the walk uses. */
const SOURCE_ROWS = 240;

/**
 * Where the rows carrying another court's ECLI sit. Spread on purpose, and
 * with a long run of publisher rows after the last of them: a walk that only
 * advanced on a match would stall exactly there.
 */
const FOREIGN_ROWS = new Map<number, string>([
  [3, "KSOS"],
  [4, "VSPH"],
  [97, "KSBR"],
  [98, "MSPH"],
  [140, "OSOV"],
]);

const fixtureIds = Array.from({ length: SOURCE_ROWS }, () =>
  createSafeId<"caseLawDecision">(),
);

/** The id at `index`, which the fixture array is built to hold. */
const fixtureId = (index: number): SafeId<"caseLawDecision"> => {
  const id = fixtureIds[index];
  if (id === undefined) {
    throw new Error(`no fixture at ${String(index)}`);
  }
  return id;
};

/** The ECLI row `index` carries: the publisher's own, unless planted. */
const ecliOf = (index: number): string =>
  `ECLI:CZ:${FOREIGN_ROWS.get(index) ?? PUBLISHER_ECLI_CODE}:2011:${String(index)}.CO.19.2011.1`;

const foreignIds = new Set([...FOREIGN_ROWS.keys()].map(fixtureId));

/** Read one page, exactly as the script reads it. */
const readPage = async (
  after: CzNsCourtCursor | null,
  pageSize: number,
): Promise<CzNsCourtPage> =>
  parseCzNsCourtPage(
    executedRows(
      await db.execute(
        selectCzNsCourtPageStatement({
          after,
          pageSize,
          publisherEcliCode: PUBLISHER_ECLI_CODE,
          sourceId: nsSourceId,
        }),
      ),
    ),
  );

type Walk = {
  /** Every page the walk read, in order. */
  pages: CzNsCourtPage[];
  rows: CzNsCourtRow[];
};

/** Walk the source to its end, as the script's loop does. */
const walk = async (pageSize: number): Promise<Walk> => {
  const pages: CzNsCourtPage[] = [];
  const rows: CzNsCourtRow[] = [];
  let cursor: CzNsCourtCursor | null = null;
  // A walk that does not terminate is the failure this test exists to catch,
  // so the loop is bounded and the bound is asserted rather than trusted.
  for (let read = 0; read <= SOURCE_ROWS + 2; read += 1) {
    const page = await readPage(cursor, pageSize);
    pages.push(page);
    rows.push(...page.rows);
    if (page.cursor === null) {
      return { pages, rows };
    }
    cursor = page.cursor;
  }
  throw new Error("the walk did not reach the end of the source");
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: nsSourceId, adapterKey: "cz-ns", name: "cz-ns source" },
      { id: nssSourceId, adapterKey: "cz-nss", name: "cz-nss source" },
    ]);

    await db.insert(caseLawDecisions).values([
      ...fixtureIds.map((id, index) => ({
        id,
        sourceId: nsSourceId,
        caseNumber: `${String(index)} C ${String(index)}/2020`,
        // Every row carries the publisher's name, which is the fault.
        court: PUBLISHER_COURT,
        country: "CZE",
        language: "cs",
        ecli: ecliOf(index),
        metadata: { court: PUBLISHER_COURT },
        contentHash: "a".repeat(64),
        indexedHash: "a".repeat(64),
        slug: `ns-${String(index)}`,
        languageGroupKey: `ns-${String(index)}`,
        // Distinct and increasing, so the walk's order is the one the index
        // serves and a page boundary falls where this test says it does.
        createdAt: new Date(STORED_AT.getTime() + index * 1000),
        updatedAt: STORED_AT,
      })),
      // Another source's row, carrying a foreign ECLI: this repair owns its
      // own source and must not read, let alone rewrite, anyone else's.
      {
        id: createSafeId<"caseLawDecision">(),
        sourceId: nssSourceId,
        caseNumber: "62 A 1/2020",
        court: PUBLISHER_COURT,
        country: "CZE",
        language: "cs",
        ecli: "ECLI:CZ:KSBR:2020:62.A.1.2020.1",
        metadata: { court: PUBLISHER_COURT },
        slug: "nss-1",
        languageGroupKey: "nss-1",
        createdAt: STORED_AT,
        updatedAt: STORED_AT,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

describe("the walk", () => {
  test("finds the source by the adapter that wrote it", async () => {
    expect(
      parseCzNsSourceId(
        executedRows(await db.execute(czNsSourceIdStatement("cz-ns"))),
      ),
    ).toBe(nsSourceId);
    expect(
      parseCzNsSourceId(
        executedRows(await db.execute(czNsSourceIdStatement("cz-none"))),
      ),
    ).toBeNull();
  });

  test("examines one bounded page per statement", async () => {
    const pageSize = 50;
    const { pages } = await walk(pageSize);

    // What bounds a statement is rows examined, so that is what is asserted:
    // no page may read more than it was given, however few of its rows match.
    expect(pages.every((page) => page.scanned <= pageSize)).toBe(true);
    // Every row of the source is examined exactly once, and the walk stops on
    // the empty page that follows the last full one.
    expect(pages.reduce((total, page) => total + page.scanned, 0)).toBe(
      SOURCE_ROWS,
    );
    expect(pages).toHaveLength(Math.ceil(SOURCE_ROWS / pageSize) + 1);
    expect(pages.at(-1)?.cursor).toBeNull();
  });

  test("advances over a page whose rows all hold", async () => {
    const { pages } = await walk(50);
    const barren = pages.filter(
      (page) => page.scanned > 0 && page.rows.length === 0,
    );
    // The fixture puts a long run of publisher rows after the last planted
    // one, so this is not a vacuous filter: a page that matched nothing still
    // states where the next one starts.
    expect(barren.length).toBeGreaterThan(0);
    expect(barren.every((page) => page.cursor !== null)).toBe(true);
  });

  test("reads the same rows however it is paged", async () => {
    const finely = await walk(7);
    const coarsely = await walk(SOURCE_ROWS * 2);

    expect(finely.rows.map((row) => row.id).sort()).toEqual(
      coarsely.rows.map((row) => row.id).sort(),
    );
    expect(coarsely.pages).toHaveLength(2);
  });

  test("reads this source's rows whose own ECLI names another court", async () => {
    const { rows } = await walk(50);
    expect(new Set(rows.map((row) => row.id))).toEqual(foreignIds);
  });
});

describe("the write", () => {
  test("writes the court and the copy the row's metadata carries", async () => {
    const { rows } = await walk(50);
    for (const row of rows) {
      const repair = decideCzNsCourtRepair(row);
      if (repair.outcome !== CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED) {
        throw new Error(`Expected a re-attribution, got ${repair.outcome}`);
      }
      const written = executedRows(
        await db.execute(
          applyCzNsCourtRepairStatement({
            court: repair.court,
            from: repair.from,
            id: repair.id,
          }),
        ),
      );
      expect(written).toHaveLength(1);

      const stored = (
        await db
          .select({
            court: caseLawDecisions.court,
            indexedHash: caseLawDecisions.indexedHash,
            metadata: caseLawDecisions.metadata,
            updatedAt: caseLawDecisions.updatedAt,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, repair.id))
      ).at(0);
      expect(stored?.court).toBe(repair.court);
      expect(stored?.metadata?.["court"]).toBe(repair.court);
      // Both search projections read a mark rather than the court itself: the
      // full-text one compares this timestamp against its own, and the legacy
      // corpus index treats a cleared hash as work. A row whose court moved
      // and whose marks did not is served under its old court for good.
      expect(stored?.indexedHash).toBeNull();
      expect(stored?.updatedAt.getTime()).toBeGreaterThan(STORED_AT.getTime());
    }

    // Idempotent: the repaired rows still come back from the walk, and the
    // decision now holds them rather than re-attributing them again.
    const second = await walk(50);
    expect(
      second.rows.map((row) => decideCzNsCourtRepair(row).outcome),
    ).toEqual(second.rows.map(() => CZ_NS_COURT_REPAIR_OUTCOMES.HELD));
  });

  test("refuses a write whose row changed under the run", async () => {
    const row = (await walk(50)).rows.at(0);
    if (row === undefined) {
      throw new Error("Expected a row to write");
    }
    expect(
      executedRows(
        await db.execute(
          applyCzNsCourtRepairStatement({
            court: "Krajský soud v Brně",
            from: PUBLISHER_COURT,
            id: row.id,
          }),
        ),
      ),
    ).toEqual([]);
  });
});
