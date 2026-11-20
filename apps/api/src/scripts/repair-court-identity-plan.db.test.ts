/**
 * The repair's statements against a real PostgreSQL: the walk, which decides
 * which stored rows are looked at, and the writes, which decide what a
 * looked-at row becomes. An operator script's SQL is executed nowhere else.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { assignDecisionCourtIdsTx } from "@/api/lib/case-law/decision-court-assignment";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  COURT_IDENTITY_REPAIR_OUTCOMES,
  type CourtIdentityAssignment,
  type CourtIdentityCursor,
  type CourtIdentityRow,
  courtIdentitySourcesStatement,
  decideCourtIdentityRepair,
  parseCourtIdentityPage,
  parseCourtIdentitySources,
  renameCourtStatement,
  revertCourtIdentityStatement,
  selectCourtIdentityPageStatement,
} from "@/api/scripts/repair-court-identity-plan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const regionalSourceId = createSafeId<"caseLawSource">();
const otherSourceId = createSafeId<"caseLawSource">();

const STORED_AT = new Date("2020-01-01T00:00:00.000Z");

const PRINTED = "Krajský soud v Hradci Králové, pobočka Pardubice";
const OFFICIAL = "Krajský soud v Hradci Králové – pobočka v Pardubicích";

/** What each fixture row is stored under, in walk order. */
const FIXTURES = [
  { court: PRINTED, metadata: { court: PRINTED } },
  { court: PRINTED, metadata: {} },
  { court: OFFICIAL, metadata: { court: OFFICIAL } },
  { court: "Neznámý soud 58", metadata: { court: "Neznámý soud 58" } },
  { court: "Okresní soud v Benešově", metadata: {} },
] as const;

const ids = FIXTURES.map(() => createSafeId<"caseLawDecision">());
const idAt = (index: number): SafeId<"caseLawDecision"> => {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`no fixture at ${String(index)}`);
  }
  return id;
};

const stored = async (id: SafeId<"caseLawDecision">) => {
  const [row] = await db
    .select({
      court: caseLawDecisions.court,
      courtId: caseLawDecisions.courtId,
      metadata: caseLawDecisions.metadata,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  if (row === undefined) {
    throw new Error(`no row ${id}`);
  }
  return row;
};

const walk = async (pageSize: number): Promise<CourtIdentityRow[]> => {
  const rows: CourtIdentityRow[] = [];
  let cursor: CourtIdentityCursor | null = null;
  for (let read = 0; read <= FIXTURES.length + 2; read += 1) {
    const page = parseCourtIdentityPage(
      executedRows(
        await db.execute(
          selectCourtIdentityPageStatement({
            after: cursor,
            pageSize,
            sourceId: regionalSourceId,
          }),
        ),
      ),
    );
    if (page.cursor === null) {
      return rows;
    }
    rows.push(...page.rows);
    cursor = page.cursor;
  }
  throw new Error("the walk did not reach the end of the source");
};

const assignmentOf = (row: CourtIdentityRow): CourtIdentityAssignment => {
  const repair = decideCourtIdentityRepair(row);
  if (
    repair.outcome !== COURT_IDENTITY_REPAIR_OUTCOMES.RENAME &&
    repair.outcome !== COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID
  ) {
    throw new Error(`expected an assignment, got ${repair.outcome}`);
  }
  return repair;
};

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values([
    { id: regionalSourceId, adapterKey: "cz-regional", name: "regional" },
    { id: otherSourceId, adapterKey: "pl-courts", name: "other" },
  ]);
  await db.insert(caseLawDecisions).values([
    ...FIXTURES.map(({ court, metadata }, index) => ({
      id: idAt(index),
      sourceId: regionalSourceId,
      caseNumber: `${String(index)} C ${String(index)}/2020`,
      court,
      country: "CZE",
      language: "cs",
      metadata,
      slug: `regional-${String(index)}`,
      languageGroupKey: `regional-${String(index)}`,
      createdAt: new Date(STORED_AT.getTime() + index * 1000),
      updatedAt: STORED_AT,
    })),
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId: otherSourceId,
      caseNumber: "I C 1/2020",
      court: PRINTED,
      country: "CZE",
      language: "cs",
      metadata: {},
      slug: "other-1",
      languageGroupKey: "other-1",
      createdAt: STORED_AT,
      updatedAt: STORED_AT,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
});

describe("repair-court-identity statements", () => {
  test("looks sources up by the adapters that wrote them", async () => {
    const sources = parseCourtIdentitySources(
      executedRows(
        await db.execute(courtIdentitySourcesStatement(["cz-regional"])),
      ),
    );
    expect(sources).toEqual([
      { id: regionalSourceId, adapterKey: "cz-regional" },
    ]);
  });

  test("walks every row of its own source once, across page boundaries", async () => {
    const rows = await walk(2);
    expect(rows.map(({ id }) => id)).toEqual(ids);
    expect(rows.map(({ metadataHasCourt }) => metadataHasCourt)).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
  });

  test("renames, assigns, leaves unknown names alone, and reverts what it wrote", async () => {
    const rows = await walk(10);
    const [printedWithMetadata, printedBare, official, unknown, benesov] = rows;
    if (
      printedWithMetadata === undefined ||
      printedBare === undefined ||
      official === undefined ||
      unknown === undefined ||
      benesov === undefined
    ) {
      throw new Error("the walk lost a fixture");
    }
    expect(decideCourtIdentityRepair(unknown).outcome).toBe(
      COURT_IDENTITY_REPAIR_OUTCOMES.UNKNOWN,
    );

    for (const row of [printedWithMetadata, printedBare]) {
      const rename = assignmentOf(row);
      expect(rename.outcome).toBe(COURT_IDENTITY_REPAIR_OUTCOMES.RENAME);
      expect(
        executedRows(
          await db.execute(renameCourtStatement({ ...rename, id: row.id })),
        ).length,
      ).toBe(1);
      // A second write is guarded out: the row no longer holds the name read.
      expect(
        executedRows(
          await db.execute(renameCourtStatement({ ...rename, id: row.id })),
        ).length,
      ).toBe(0);
    }
    // The adapter's own statement of the court is never overwritten; where
    // there was none, the printed name is kept beside the official one.
    expect(await stored(printedWithMetadata.id)).toMatchObject({
      court: OFFICIAL,
      courtId: "KSHKPA",
      metadata: { court: PRINTED },
    });
    expect(await stored(printedBare.id)).toMatchObject({
      court: OFFICIAL,
      courtId: "KSHKPA",
      metadata: { court: PRINTED },
    });

    const idOnly = [assignmentOf(official), assignmentOf(benesov)];
    expect(idOnly.map(({ outcome }) => outcome)).toEqual([
      COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID,
      COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID,
    ]);
    expect(
      (
        await db.transaction(
          async (tx) =>
            await assignDecisionCourtIdsTx(asTestRaw<Transaction>(tx), {
              sourceId: regionalSourceId,
              assignments: idOnly.map(({ row, to, courtId }) => ({
                decisionId: row.id,
                court: to,
                courtId,
              })),
            }),
        )
      ).length,
    ).toBe(2);
    expect((await stored(official.id)).courtId).toBe("KSHKPA");
    expect((await stored(benesov.id)).courtId).toBe("OSBN");
    expect(await stored(unknown.id)).toMatchObject({
      court: "Neznámý soud 58",
      courtId: null,
    });

    // The next walk holds every repaired row.
    const again = await walk(10);
    expect(again.map((row) => decideCourtIdentityRepair(row).outcome)).toEqual([
      COURT_IDENTITY_REPAIR_OUTCOMES.HELD,
      COURT_IDENTITY_REPAIR_OUTCOMES.HELD,
      COURT_IDENTITY_REPAIR_OUTCOMES.HELD,
      COURT_IDENTITY_REPAIR_OUTCOMES.UNKNOWN,
      COURT_IDENTITY_REPAIR_OUTCOMES.HELD,
    ]);

    // A logged write reverts exactly what the run wrote.
    expect(
      executedRows(
        await db.execute(
          revertCourtIdentityStatement({
            id: printedBare.id,
            adapter: "cz-regional",
            from: PRINTED,
            to: OFFICIAL,
            courtId: "KSHKPA",
            previousCourtId: null,
            addedMetadataCourt: true,
          }),
        ),
      ).length,
    ).toBe(1);
    expect(await stored(printedBare.id)).toEqual({
      court: PRINTED,
      courtId: null,
      metadata: {},
    });
  });
});
