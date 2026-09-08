/**
 * The repair's two halves against a real PostgreSQL: the predicate, which
 * decides which stored rows are looked at at all, and the write, which decides
 * what a looked-at row becomes. Neither is exercised anywhere else — an
 * operator script's SQL is never executed by CI — and a predicate that selects
 * the wrong population is a repair that rewrites decisions nobody asked it to.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  applyCzNsCourtRepairStatement,
  CZ_NS_COURT_REPAIR_OUTCOMES,
  decideCzNsCourtRepair,
  executedRows,
  parseCzNsCourtRow,
  selectCzNsForeignCourtRowsStatement,
} from "@/api/scripts/repair-cz-ns-court-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const nsSourceId = createSafeId<"caseLawSource">();
const nssSourceId = createSafeId<"caseLawSource">();

const PUBLISHER_COURT = "Nejvyšší soud";

type Fixture = {
  ecli: string | null;
  id: SafeId<"caseLawDecision">;
  label: string;
  sourceId: SafeId<"caseLawSource">;
};

const fixtures: readonly Fixture[] = [
  {
    ecli: "ECLI:CZ:KSOS:2011:75.CO.19.2011.1",
    id: createSafeId<"caseLawDecision">(),
    label: "regional court published by the Supreme Court",
    sourceId: nsSourceId,
  },
  {
    ecli: "ECLI:CZ:VSPH:2015:1.VSPH.9.2015.1",
    id: createSafeId<"caseLawDecision">(),
    label: "high court published by the Supreme Court",
    sourceId: nsSourceId,
  },
  {
    ecli: "ECLI:CZ:NS:2015:23.CDO.3470.2015.1",
    id: createSafeId<"caseLawDecision">(),
    label: "the publisher's own decision",
    sourceId: nsSourceId,
  },
  {
    ecli: null,
    id: createSafeId<"caseLawDecision">(),
    label: "no ECLI, so no court signal in the row",
    sourceId: nsSourceId,
  },
  {
    ecli: "ECLI:CZ:KSBR:2020:62.A.1.2020.1",
    id: createSafeId<"caseLawDecision">(),
    label: "another source's row, which this repair does not own",
    sourceId: nssSourceId,
  },
];

const labelOf = new Map(fixtures.map((fixture) => [fixture.id, fixture.label]));

const selection = async (
  after: SafeId<"caseLawDecision"> | null,
  limit: number,
) =>
  executedRows(
    await db.execute(
      selectCzNsForeignCourtRowsStatement({
        adapterKey: "cz-ns",
        after,
        limit,
        publisherEcliCode: "NS",
      }),
    ),
  ).map(parseCzNsCourtRow);

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: nsSourceId, adapterKey: "cz-ns", name: "cz-ns source" },
      { id: nssSourceId, adapterKey: "cz-nss", name: "cz-nss source" },
    ]);

    await db.insert(caseLawDecisions).values(
      fixtures.map((fixture, index) => ({
        id: fixture.id,
        sourceId: fixture.sourceId,
        caseNumber: `${String(index)} C ${String(index)}/2020`,
        // Every row carries the publisher's name, which is the fault.
        court: PUBLISHER_COURT,
        country: "CZE",
        language: "cs",
        ecli: fixture.ecli,
        metadata: { court: PUBLISHER_COURT, ecli: fixture.ecli },
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

test("selects the source's rows whose own ECLI names another court", async () => {
  const selected = await selection(null, 100);
  expect(new Set(selected.map(({ id }) => labelOf.get(id)))).toEqual(
    new Set([
      "regional court published by the Supreme Court",
      "high court published by the Supreme Court",
    ]),
  );
});

test("pages on the primary key, so a held row is not read forever", async () => {
  const first = await selection(null, 1);
  expect(first).toHaveLength(1);
  const firstRow = first.at(0);
  if (firstRow === undefined) {
    throw new Error("Expected a first page");
  }
  const second = await selection(firstRow.id, 1);
  expect(second.at(0)?.id).not.toBe(firstRow.id);
  expect(await selection(second.at(0)?.id ?? null, 1)).toEqual([]);
});

test("writes the court and the copy the row's metadata carries", async () => {
  const rows = await selection(null, 100);
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
          metadata: caseLawDecisions.metadata,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, repair.id))
    ).at(0);
    expect(stored?.court).toBe(repair.court);
    expect(stored?.metadata?.["court"]).toBe(repair.court);
  }

  // Idempotent: the repaired rows have left the decision's re-attribution
  // branch, so a second pass writes nothing.
  const second = await selection(null, 100);
  expect(second.map((row) => decideCzNsCourtRepair(row).outcome)).toEqual(
    second.map(() => CZ_NS_COURT_REPAIR_OUTCOMES.HELD),
  );
});

test("refuses a write whose row changed under the run", async () => {
  const row = (await selection(null, 100)).at(0);
  if (row === undefined) {
    throw new Error("Expected a selected row");
  }
  const written = executedRows(
    await db.execute(
      applyCzNsCourtRepairStatement({
        court: "Krajský soud v Brně",
        from: PUBLISHER_COURT,
        id: row.id,
      }),
    ),
  );
  expect(written).toEqual([]);
});
