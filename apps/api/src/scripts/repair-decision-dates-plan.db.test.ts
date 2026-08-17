import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { canonicalDecisionDate } from "@/api/lib/dates";
import { isRecord } from "@/api/lib/type-guards";
import type {
  CorruptDecisionDateRow,
  DecisionDateRowLock,
} from "@/api/scripts/repair-decision-dates-plan";
import {
  applyDecisionDateRepairsStatement,
  DECISION_DATE_REPAIR_OUTCOMES,
  DECISION_DATE_ROW_LOCKS,
  decideDecisionDateRepair,
  decisionDateSourceSurveyStatement,
  decisionDateYearSurveyStatement,
  parseCorruptDecisionDateRow,
  selectCorruptDecisionDatesStatement,
} from "@/api/scripts/repair-decision-dates-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The repair's two halves are each other's blind spot: the predicate decides
 * which rows are touched at all, and the per-row decision decides what a
 * touched row becomes. Both run here against a real PostgreSQL, over fixtures
 * shaped like the rows production actually holds — a corrupt `decision_date`
 * whose `metadata.decisionDate` carries the byte-identical corrupt string,
 * which is what makes re-derivation from the row worthless for that source.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const czSourceId = createSafeId<"caseLawSource">();
const plSourceId = createSafeId<"caseLawSource">();

const currentYear = new Date().getUTCFullYear();

type Fixture = {
  adapterKey: string;
  id: SafeId<"caseLawDecision">;
  /** What `decision_date` holds. `null` rows must never be selected. */
  decisionDate: string | null;
  label: string;
  metadata: Record<string, unknown>;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * `metadata.decisionDate` mirroring the stored value is the production shape:
 * the adapters that normalize a date write the normalized value into metadata,
 * and cz-regional copies the publisher's string into both places unchanged.
 */
const mirrored = (date: string, publishedDate: string) => ({
  decisionDate: date,
  publishedDate,
});

const fixtures: readonly Fixture[] = [
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "2944-04-30",
    label: "far-future year",
    metadata: mirrored("2944-04-30", "2024-01-23"),
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "1168-10-28",
    label: "medieval year",
    metadata: mirrored("1168-10-28", "2022-10-25"),
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "0001-01-01",
    label: "year one",
    metadata: mirrored("0001-01-01", "2024-01-23"),
    sourceId: czSourceId,
  },
  {
    adapterKey: "pl-courts",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "3013-12-04",
    label: "fourth-millennium year",
    metadata: mirrored("3013-12-04", "2021-05-05"),
    sourceId: plSourceId,
  },
  {
    // Synthetic on purpose: no adapter stores a raw date under this key today
    // that differs from the column, which is exactly the claim the run has to
    // keep proving per row rather than assuming. Without a fixture the
    // re-derivation branch can reach, "nothing was re-derived" would be a
    // result the test could not tell apart from a broken branch.
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "2417-05-05",
    label: "metadata keeps a usable date",
    metadata: { decisionDate: "2017-05-05", publishedDate: "2017-06-01" },
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "1799-12-31",
    label: "day before the floor",
    metadata: mirrored("1799-12-31", "2023-02-23"),
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: "1800-01-01",
    label: "the floor itself",
    metadata: mirrored("1800-01-01", "2023-02-23"),
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: `${String(currentYear + 1)}-12-31`,
    label: "last day the guard still accepts",
    metadata: {},
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: `${String(currentYear + 2)}-01-01`,
    label: "first day past the ceiling",
    metadata: {},
    sourceId: czSourceId,
  },
  {
    adapterKey: "cz-regional",
    id: createSafeId<"caseLawDecision">(),
    decisionDate: null,
    label: "already absent",
    metadata: {},
    sourceId: czSourceId,
  },
];

const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

/** The rows the write-path guard would refuse to store today. */
const rejectedByGuard = fixtures.filter(
  (fixture) =>
    fixture.decisionDate !== null &&
    canonicalDecisionDate(fixture.decisionDate) === null,
);

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: czSourceId, adapterKey: "cz-regional", name: "cz source" },
      { id: plSourceId, adapterKey: "pl-courts", name: "pl source" },
    ]);

    await db.insert(caseLawDecisions).values(
      fixtures.map((fixture, index) => ({
        id: fixture.id,
        sourceId: fixture.sourceId,
        caseNumber: `${String(index)} C ${String(index)}/2020`,
        court: "Krajský soud",
        country: fixture.adapterKey === "pl-courts" ? "POL" : "CZE",
        language: fixture.adapterKey === "pl-courts" ? "pl" : "cs",
        decisionDate: fixture.decisionDate,
        metadata: fixture.metadata,
        // Both hashes present and equal: the row reads as projected and
        // up to date, which is the state a date-only change has to disturb.
        contentHash: "a".repeat(64),
        indexedHash: "a".repeat(64),
        slug: `fixture-${String(index)}`,
        languageGroupKey: `fixture-${String(index)}`,
      })),
    );
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const corruptRows = async (
  limit: number,
  lock: DecisionDateRowLock = DECISION_DATE_ROW_LOCKS.NONE,
): Promise<CorruptDecisionDateRow[]> =>
  executedRows(
    await db.execute(selectCorruptDecisionDatesStatement({ limit, lock })),
  ).map(parseCorruptDecisionDateRow);

test("the selection is exactly what the write-path guard rejects", async () => {
  // Both directions, so neither a predicate that over-selects nor one that
  // silently misses a boundary can pass. The fixtures straddle both bounds, so
  // the sets differ from "everything" and from "nothing" in each direction.
  const selected = new Set((await corruptRows(100)).map(({ id }) => id));
  const rejected = new Set(rejectedByGuard.map(({ id }) => id));

  expect([...selected].toSorted()).toEqual([...rejected].toSorted());
  // The repairing variant claims its rows before the citation-graph lock, in
  // the ingestion pipeline's lock order. `FOR UPDATE OF d` over a join is only
  // valid SQL against the right alias, and it must not change what is selected.
  expect(
    (await corruptRows(100, DECISION_DATE_ROW_LOCKS.FOR_UPDATE))
      .map(({ id }) => id)
      .toSorted(),
  ).toEqual([...rejected].toSorted());
  // Guards the assertion above against a fixture set that made it vacuous.
  expect(selected.size).toBeGreaterThan(0);
  expect(selected.size).toBeLessThan(fixtures.length);
  for (const fixture of fixtures) {
    if (!selected.has(fixture.id)) {
      continue;
    }
    expect(fixture.decisionDate).not.toBeNull();
  }
});

test("the surveys count the same population without writing", async () => {
  const bySource = executedRows(
    await db.execute(decisionDateSourceSurveyStatement(50)),
  );
  const byYear = executedRows(
    await db.execute(decisionDateYearSurveyStatement(50)),
  );

  const countRows = (rows: readonly unknown[]): number => {
    let sum = 0;
    for (const row of rows) {
      if (isRecord(row) && typeof row["rows"] === "number") {
        sum += row["rows"];
      }
    }
    return sum;
  };
  expect(countRows(bySource)).toBe(rejectedByGuard.length);
  expect(countRows(byYear)).toBe(rejectedByGuard.length);
  expect(
    bySource.map((row) => (isRecord(row) ? row["adapterKey"] : null)),
  ).toEqual(["cz-regional", "pl-courts"]);

  // A dry run reads; it must leave the population exactly as it found it.
  expect((await corruptRows(100)).length).toBe(rejectedByGuard.length);
});

test("a row keeps a re-derivable date and loses an unrecoverable one", async () => {
  const decided = (await corruptRows(100)).map(decideDecisionDateRepair);
  const labelOf = (id: SafeId<"caseLawDecision">): string =>
    fixtureById.get(id)?.label ?? id;

  const rederived = decided.filter(
    ({ outcome }) => outcome === DECISION_DATE_REPAIR_OUTCOMES.REDERIVED,
  );
  expect(
    rederived.map(({ decisionDate, id }) => ({
      decisionDate,
      label: labelOf(id),
    })),
  ).toEqual([
    { decisionDate: "2017-05-05", label: "metadata keeps a usable date" },
  ]);

  // Every other row is cleared, including the ones whose metadata carries a
  // plausible `publishedDate`: publication is not decision.
  for (const { decisionDate, outcome } of decided) {
    if (outcome === DECISION_DATE_REPAIR_OUTCOMES.CLEARED) {
      expect(decisionDate).toBeNull();
    }
  }
  expect(decided.length - rederived.length).toBe(rejectedByGuard.length - 1);
});

test("applying writes the decisions, re-enqueues them, and converges", async () => {
  const before = await corruptRows(100);
  expect(before.length).toBeGreaterThan(0);
  const repairs = before.map(decideDecisionDateRepair);

  // A crawl that re-observed one of these rows between the selection and the
  // write already stored whatever the write-path guard allowed. The statement
  // re-checks the predicate, so this run's older decision must not undo it.
  const raced = before[0];
  if (raced === undefined) {
    throw new Error("no corrupt row to race");
  }
  await db
    .update(caseLawDecisions)
    .set({ decisionDate: "2020-02-02" })
    .where(inArray(caseLawDecisions.id, [raced.id]));

  const written = new Set(
    executedRows(await db.execute(applyDecisionDateRepairsStatement(repairs)))
      .filter(isRecord)
      .map((row) => String(row["id"])),
  );
  expect(written.has(raced.id)).toBe(false);
  expect(written.size).toBe(repairs.length - 1);

  // Selecting again finds nothing: every repaired row left the predicate, which
  // is what lets the batch loop terminate without a cursor.
  expect(await corruptRows(100)).toEqual([]);

  const stored = await db
    .select({
      id: caseLawDecisions.id,
      decisionDate: caseLawDecisions.decisionDate,
      indexedHash: caseLawDecisions.indexedHash,
    })
    .from(caseLawDecisions);
  const byId = new Map(stored.map((row) => [String(row.id), row]));

  expect(byId.get(raced.id)?.decisionDate).toBe("2020-02-02");
  // Untouched by this statement, so still carrying the hash the fixture set.
  expect(byId.get(raced.id)?.indexedHash).toBe("a".repeat(64));

  for (const { decisionDate, id } of repairs) {
    if (!written.has(id)) {
      continue;
    }
    expect(byId.get(id)?.decisionDate).toBe(decisionDate);
    // A date-only change leaves `content_hash` alone, so clearing this is the
    // only thing that puts the row back in front of the search projection.
    expect(byId.get(id)?.indexedHash).toBeNull();
  }

  // Rows the predicate never selected keep both their date and their
  // projection state: a run cannot widen into dates the guard accepts.
  for (const fixture of fixtures) {
    if (before.some(({ id }) => id === fixture.id)) {
      continue;
    }
    expect(byId.get(fixture.id)?.decisionDate).toBe(fixture.decisionDate);
    expect(byId.get(fixture.id)?.indexedHash).toBe("a".repeat(64));
  }
});
