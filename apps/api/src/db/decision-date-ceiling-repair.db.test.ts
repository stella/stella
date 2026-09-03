import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { addUtcDays, toUtcDateString } from "@/api/lib/dates";
import { CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT } from "@/api/lib/decision-date-bounds-sql";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { DECISION_DATE_CEILING_REPAIR } from "./decision-date-ceiling-repair";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/**
 * The ceiling migration and its online repair against a table still carrying
 * the previous constraint, the state an upgraded database is in: the
 * migration swaps the CHECK and touches no row, the repair clears the rows the
 * new ceiling refuses and reopens every citation direction they decided, then
 * validates, and a second run of either changes nothing.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260902100000_case_law_decision_date_ceiling/migration.sql",
);

const PREVIOUS_CONSTRAINT = `
  ALTER TABLE "case_law_decisions"
    ADD CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"
    CHECK (
      "decision_date" IS NULL
      OR (
        "decision_date" >= make_date(1800, 1, 1)
        AND "decision_date" < make_date(
          extract(year from (now() AT TIME ZONE 'UTC'))::int + 2, 1, 1)
      )
    )`;

const SHARED_KEY = "cze:os:2-c-2/2026";

const day = (offset: number) => toUtcDateString(addUtcDays(new Date(), offset));

type PgliteClient = Awaited<ReturnType<typeof createTestPglite>>;

type ConstraintState = { definition: string; isValidated: boolean };

const constraintState = async (
  db: ReturnType<typeof drizzle>,
): Promise<ConstraintState | null> => {
  const result: unknown = await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS definition, convalidated AS "isValidated"
      FROM pg_constraint
     WHERE conname = ${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}
       AND conrelid = 'case_law_decisions'::regclass
  `);
  let rows: unknown[] = [];
  if (Array.isArray(result)) {
    rows = result;
  } else if (isRecord(result) && Array.isArray(result["rows"])) {
    rows = result["rows"];
  }
  const row = rows.at(0);
  if (
    !isRecord(row) ||
    typeof row["definition"] !== "string" ||
    typeof row["isValidated"] !== "boolean"
  ) {
    return null;
  }
  return { definition: row["definition"], isValidated: row["isValidated"] };
};

type ConnectionOptions = {
  /** Throw instead of running the statement; `count` is how many times it has been seen so far. */
  failOn?: (statement: string, count: number) => boolean;
};

/** The migrate entrypoint's reserved connection, over the test database. */
const connectionOver = (
  client: PgliteClient,
  { failOn = () => false }: ConnectionOptions = {},
): OnlineMigrationConnection => {
  const seen = new Map<string, number>();
  return {
    execute: async (query, params = []) => {
      const count = (seen.get(query) ?? 0) + 1;
      seen.set(query, count);
      if (failOn(query, count)) {
        throw new Error(`connection dropped at ${query}`);
      }
      await client.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await client.query(query, [...params])).rows,
    release: () => {},
  };
};

const migrationStatements = async (): Promise<string[]> =>
  (await Bun.file(MIGRATION_PATH).text())
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const applyMigration = async (db: ReturnType<typeof drizzle>) => {
  for (const statement of await migrationStatements()) {
    // oxlint-disable-next-line no-await-in-loop -- statements apply in order
    await db.execute(sql.raw(statement));
  }
};

const installPreviousConstraint = async (db: ReturnType<typeof drizzle>) => {
  await db.execute(
    sql.raw(
      `ALTER TABLE "case_law_decisions" DROP CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"`,
    ),
  );
  await db.execute(sql.raw(PREVIOUS_CONSTRAINT));
  expect((await constraintState(db))?.definition).toMatch(/extract\(year/iu);
};

const snapshot = async (db: ReturnType<typeof drizzle>) => ({
  citations: await db
    .select({
      citingDecisionId: caseLawCitations.citingDecisionId,
      citedDecisionId: caseLawCitations.citedDecisionId,
      citationText: caseLawCitations.citationText,
      resolutionStatus: caseLawCitations.resolutionStatus,
    })
    .from(caseLawCitations)
    .orderBy(caseLawCitations.citationText),
  decisions: await db
    .select({
      id: caseLawDecisions.id,
      decisionDate: caseLawDecisions.decisionDate,
      indexedHash: caseLawDecisions.indexedHash,
    })
    .from(caseLawDecisions)
    .orderBy(caseLawDecisions.id),
});

const corruptCount = async (
  db: ReturnType<typeof drizzle>,
): Promise<number> => {
  const rows = await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      sql`${caseLawDecisions.decisionDate} >= ((now() AT TIME ZONE 'UTC')::date + 2)`,
    );
  return rows.length;
};

const rejectionOf = async (run: Promise<void>): Promise<string> =>
  await run.then(
    () => "",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );

test("the migration swaps the CHECK untouched, the repair clears and reopens, both converge", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const connection = connectionOver(client);
  await installPreviousConstraint(db);

  const sourceId = createSafeId<"caseLawSource">();
  await db
    .insert(caseLawSources)
    .values([{ id: sourceId, adapterKey: "cz-regional", name: "cz" }]);
  const keptId = createSafeId<"caseLawDecision">();
  const clearedId = createSafeId<"caseLawDecision">();
  const rederivedId = createSafeId<"caseLawDecision">();
  const twinId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  const decision = (
    id: typeof keptId,
    caseNumber: string,
    rest: Partial<typeof caseLawDecisions.$inferInsert>,
  ) => ({
    id,
    sourceId,
    caseNumber,
    court: "Okresní soud",
    country: "CZE",
    language: "cs",
    ...rest,
  });
  await db.insert(caseLawDecisions).values([
    decision(keptId, "1 C 1/2026", {
      decisionDate: day(1),
      indexedHash: "kept",
    }),
    // Admitted by the previous ceiling, refused by the new one; nothing in
    // the row survives, so it is cleared.
    decision(clearedId, "2 C 2/2026", {
      citationKey: SHARED_KEY,
      decisionDate: day(40),
      indexedHash: "stale",
    }),
    // Refused too, but its own metadata carries the date the ingest lost.
    decision(rederivedId, "4 C 4/2026", {
      decisionDate: day(40),
      indexedHash: "stale",
      metadata: { decisionDate: "2020-05-05" },
    }),
    // Shares the cleared decision's key: an edge drawn to it while the
    // cleared decision was dated out of reach was decided on a wrong filter.
    decision(twinId, "5 C 5/2026", {
      citationKey: SHARED_KEY,
      court: "Krajský soud",
      decisionDate: day(-10),
    }),
    decision(citingId, "3 C 3/2026", { decisionDate: day(0) }),
  ]);
  await db.insert(caseLawCitations).values([
    // Incoming: resolved to the cleared decision under its future date.
    {
      citingDecisionId: citingId,
      citedDecisionId: clearedId,
      citationText: "a incoming",
      resolutionStatus: "resolved",
    },
    // Untouched: neither side changes.
    {
      citingDecisionId: citingId,
      citedDecisionId: keptId,
      citationText: "b untouched",
      resolutionStatus: "resolved",
    },
    // Outgoing: the cleared decision's own citation, filtered under its date.
    {
      citingDecisionId: clearedId,
      citedDecisionId: keptId,
      citationText: "c outgoing",
      resolutionStatus: "resolved",
    },
    // Unmatched under the cleared decision's key: the time filter excluded it.
    {
      citingDecisionId: citingId,
      citationKey: SHARED_KEY,
      citationText: "d unmatched key",
      resolutionStatus: "unmatched",
    },
    // Resolved to the twin while the cleared decision could not compete.
    {
      citingDecisionId: citingId,
      citedDecisionId: twinId,
      citationKey: SHARED_KEY,
      citationText: "e contested twin",
      resolutionStatus: "resolved",
    },
    // Incoming to the re-derived decision.
    {
      citingDecisionId: citingId,
      citedDecisionId: rederivedId,
      citationText: "f incoming rederived",
      resolutionStatus: "resolved",
    },
  ]);
  const before = await snapshot(db);

  await applyMigration(db);
  const swapped = await constraintState(db);
  expect(swapped?.definition).toContain("::date + 2");
  expect(swapped?.isValidated).toBe(false);
  // Schema only: every row and every edge is as it was.
  expect(await snapshot(db)).toEqual(before);
  expect(
    await rejectionOf(DECISION_DATE_CEILING_REPAIR.assertComplete(connection)),
  ).toContain("is not validated");

  await DECISION_DATE_CEILING_REPAIR.repair(connection);
  await DECISION_DATE_CEILING_REPAIR.assertComplete(connection);
  expect((await constraintState(db))?.isValidated).toBe(true);
  const repaired = await snapshot(db);
  const decisionsById = new Map(repaired.decisions.map((row) => [row.id, row]));
  expect(decisionsById.get(keptId)).toEqual({
    id: keptId,
    decisionDate: day(1),
    indexedHash: "kept",
  });
  expect(decisionsById.get(clearedId)).toEqual({
    id: clearedId,
    decisionDate: null,
    indexedHash: null,
  });
  expect(decisionsById.get(rederivedId)).toEqual({
    id: rederivedId,
    decisionDate: "2020-05-05",
    indexedHash: null,
  });
  expect(repaired.citations).toEqual([
    {
      citingDecisionId: citingId,
      citedDecisionId: null,
      citationText: "a incoming",
      resolutionStatus: "pending",
    },
    {
      citingDecisionId: citingId,
      citedDecisionId: keptId,
      citationText: "b untouched",
      resolutionStatus: "resolved",
    },
    {
      citingDecisionId: clearedId,
      citedDecisionId: null,
      citationText: "c outgoing",
      resolutionStatus: "pending",
    },
    {
      citingDecisionId: citingId,
      citedDecisionId: null,
      citationText: "d unmatched key",
      resolutionStatus: "pending",
    },
    {
      citingDecisionId: citingId,
      citedDecisionId: null,
      citationText: "e contested twin",
      resolutionStatus: "pending",
    },
    {
      citingDecisionId: citingId,
      citedDecisionId: null,
      citationText: "f incoming rederived",
      resolutionStatus: "pending",
    },
  ]);

  // Fixed point: another run finds nothing and validates a validated CHECK.
  await DECISION_DATE_CEILING_REPAIR.repair(connection);
  expect(await snapshot(db)).toEqual(repaired);
  expect((await constraintState(db))?.isValidated).toBe(true);

  // The migration is re-runnable as a pair, and the repair validates again.
  await applyMigration(db);
  expect((await constraintState(db))?.isValidated).toBe(false);
  await DECISION_DATE_CEILING_REPAIR.repair(connection);
  expect(await snapshot(db)).toEqual(repaired);
  expect((await constraintState(db))?.isValidated).toBe(true);
  await client.close();
}, 120_000);

test("an interrupted repair keeps its committed batches and resumes by running again", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await installPreviousConstraint(db);

  const sourceId = createSafeId<"caseLawSource">();
  await db
    .insert(caseLawSources)
    .values([{ id: sourceId, adapterKey: "cz-regional", name: "cz" }]);
  const population = 120;
  await db.insert(caseLawDecisions).values(
    Array.from({ length: population }, (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `${String(index)} C ${String(index)}/2026`,
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: day(40),
      indexedHash: "stale",
    })),
  );
  await applyMigration(db);
  expect(await corruptCount(db)).toBe(population);

  // The connection drops while the second batch commits: the first batch
  // stays committed, the second is rolled back, nothing is validated.
  const dropped = connectionOver(client, {
    failOn: (statement, count) => statement === "COMMIT" && count === 2,
  });
  expect(await rejectionOf(DECISION_DATE_CEILING_REPAIR.repair(dropped))).toBe(
    "connection dropped at COMMIT",
  );
  expect(await corruptCount(db)).toBe(population - 50);
  expect((await constraintState(db))?.isValidated).toBe(false);
  expect(
    await rejectionOf(DECISION_DATE_CEILING_REPAIR.assertComplete(dropped)),
  ).toContain("is not validated");

  await DECISION_DATE_CEILING_REPAIR.repair(connectionOver(client));
  expect(await corruptCount(db)).toBe(0);
  expect((await constraintState(db))?.isValidated).toBe(true);
  const cleared = await db
    .select({ decisionDate: caseLawDecisions.decisionDate })
    .from(caseLawDecisions)
    .where(sql`${caseLawDecisions.decisionDate} IS NULL`);
  expect(cleared.length).toBe(population);
  await client.close();
}, 120_000);
