import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { CASE_LAW_DECISION_COURT_ID_CONSTRAINT } from "@/api/lib/case-law/decision-court-id-sql";
import {
  ENSURE_DECISION_COURT_ID_COLUMN_SQL,
  legacyUsaCourtIdCensus,
  repairLegacyUsaCourtIdBatch,
} from "@/api/scripts/repair-legacy-usa-court-ids-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260926110000_case_law_decision_court_id/migration.sql",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();

/** Every message down the `cause` chain of a rejection, or `""`. */
const rejectionOf = async (run: Promise<unknown>): Promise<string> => {
  const messages: string[] = [];
  try {
    await run;
  } catch (error: unknown) {
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
  }
  return messages.join("\n");
};

let inserted = 0;
const insert = async (country: string, courtId: string | null) => {
  inserted += 1;
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    caseNumber: `${String(inserted)}/2020`,
    court: "A court",
    courtId,
    country,
    language: "en",
  });
  return id;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db
      .insert(caseLawSources)
      .values([{ id: sourceId, adapterKey: "court-id", name: "court id" }]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("a USA row needs a court id and every other row refuses one", async () => {
  await insert("USA", "scotus");
  await insert("CZE", null);
  await insert("ROU", null);
  expect(await rejectionOf(insert("USA", null))).toContain(
    CASE_LAW_DECISION_COURT_ID_CONSTRAINT,
  );
  expect(await rejectionOf(insert("CZE", "scotus"))).toContain(
    CASE_LAW_DECISION_COURT_ID_CONSTRAINT,
  );
  // A changed row is held to it as well: the id cannot be dropped later.
  const usa = await insert("USA", "scotus");
  expect(
    await rejectionOf(
      db
        .update(caseLawDecisions)
        .set({ courtId: null })
        .where(eq(caseLawDecisions.id, usa)),
    ),
  ).toContain(CASE_LAW_DECISION_COURT_ID_CONSTRAINT);
});

test("the migration adds the expression the schema declares, NOT VALID", () => {
  const check = getTableConfig(caseLawDecisions).checks.find(
    ({ name }) => name === CASE_LAW_DECISION_COURT_ID_CONSTRAINT,
  );
  if (check === undefined) {
    throw new Error("schema declares no court id CHECK");
  }
  const { sql: declared, params } = new PgDialect().sqlToQuery(check.value);
  expect(params).toEqual([]);
  const added =
    /ADD CONSTRAINT "case_law_decisions_court_id_by_country"\s+CHECK \((?<body>[\s\S]*?)\) NOT VALID;/u.exec(
      readFileSync(MIGRATION_PATH, "utf-8"),
    )?.groups?.["body"];
  if (added === undefined) {
    throw new Error("migration does not add the constraint NOT VALID");
  }
  const normalize = (text: string) =>
    text.replaceAll('"case_law_decisions".', "").replaceAll(/\s+/gu, "");
  expect(normalize(added)).toBe(normalize(declared));
  // The column the operator's repair adds ahead of it is this one.
  const squash = (text: string) => text.replaceAll(/\s+/gu, " ");
  expect(squash(readFileSync(MIGRATION_PATH, "utf-8"))).toContain(
    squash(
      ENSURE_DECISION_COURT_ID_COLUMN_SQL.replace(
        'ALTER TABLE "case_law_decisions" ',
        'ALTER TABLE "case_law_decisions"\n',
      ),
    ),
  );
});

/**
 * A database as it stood before the migration: no court-id column and no
 * CHECK. Each case gets its own, since the migration changes the schema.
 */
const preMigrationDb = async () => {
  const preClient = await createTestPglite();
  const preDb = drizzle({ client: preClient });
  await preDb.execute(
    sql.raw(
      `ALTER TABLE "case_law_decisions" DROP CONSTRAINT "${CASE_LAW_DECISION_COURT_ID_CONSTRAINT}"`,
    ),
  );
  await preDb.execute(
    sql.raw(`ALTER TABLE "case_law_decisions" DROP COLUMN "court_id"`),
  );
  await preDb.execute(
    sql`INSERT INTO case_law_sources (id, adapter_key, name) VALUES (${sourceId}, 'court-id', 'court id')`,
  );
  const insertLegacy = async (country: string, court: string) => {
    const id = createSafeId<"caseLawDecision">();
    await preDb.execute(
      sql`INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language)
          VALUES (${id}, ${sourceId}, ${id}, ${court}, ${country}, 'en')`,
    );
    return id;
  };
  const migrate = async () => {
    const statements = readFileSync(MIGRATION_PATH, "utf-8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await preDb.execute(sql.raw(statement));
    }
  };
  return { preClient, preDb, insertLegacy, migrate };
};

const courtIdColumns = async (target: ReturnType<typeof drizzle>) =>
  (
    await target.execute(
      sql`SELECT 1 FROM information_schema.columns
           WHERE table_name = 'case_law_decisions' AND column_name = 'court_id'`,
    )
  ).rows.length;

test("the migration refuses a USA row without a court id and changes nothing", async () => {
  const { preClient, preDb, insertLegacy, migrate } = await preMigrationDb();
  await insertLegacy("USA", "Supreme Court of the United States");
  expect(await rejectionOf(migrate())).toContain(
    "holds 1 USA rows without a court id; run src/scripts/repair-legacy-usa-court-ids.ts --apply",
  );
  expect(await courtIdColumns(preDb)).toBe(0);
  await preClient.close();
}, 120_000);

test("the repair gives trusted legacy rows their id, after which the migration applies and every old row stays writable", async () => {
  const { preClient, preDb, insertLegacy, migrate } = await preMigrationDb();
  const scotus = await insertLegacy(
    "USA",
    "Supreme Court of the United States",
  );
  const czech = await insertLegacy("CZE", "Nejvyšší soud");

  await preDb.execute(sql.raw(ENSURE_DECISION_COURT_ID_COLUMN_SQL));
  expect(await repairLegacyUsaCourtIdBatch(preDb, 100)).toEqual([scotus]);
  // Idempotent: nothing is left to repair.
  expect(await repairLegacyUsaCourtIdBatch(preDb, 100)).toEqual([]);
  await migrate();

  const rows = await preDb
    .select({ id: caseLawDecisions.id, courtId: caseLawDecisions.courtId })
    .from(caseLawDecisions);
  expect(new Map(rows.map(({ id, courtId }) => [id, courtId]))).toEqual(
    new Map([
      [scotus, "scotus"],
      [czech, null],
    ]),
  );
  // NOT VALID is enforced on updates of old rows: both must still take one.
  for (const id of [scotus, czech]) {
    await preDb
      .update(caseLawDecisions)
      .set({ citationAuthority: 1 })
      .where(eq(caseLawDecisions.id, id));
  }
  await preClient.close();
}, 120_000);

test("the repair never assigns a court it does not trust, so the migration keeps refusing", async () => {
  const { preClient, preDb, insertLegacy, migrate } = await preMigrationDb();
  await insertLegacy("USA", "Supreme Court of the United States");
  await insertLegacy("USA", "Court of Appeals for the First Circuit");

  expect(await legacyUsaCourtIdCensus(preDb, { columnExists: false })).toEqual([
    {
      court: "Court of Appeals for the First Circuit",
      rows: 1,
      trusted: false,
    },
    { court: "Supreme Court of the United States", rows: 1, trusted: true },
  ]);
  await preDb.execute(sql.raw(ENSURE_DECISION_COURT_ID_COLUMN_SQL));
  expect(await repairLegacyUsaCourtIdBatch(preDb, 100)).toHaveLength(1);
  expect(await legacyUsaCourtIdCensus(preDb, { columnExists: true })).toEqual([
    {
      court: "Court of Appeals for the First Circuit",
      rows: 1,
      trusted: false,
    },
  ]);
  expect(await rejectionOf(migrate())).toContain("holds 1 USA rows");
  await preClient.close();
}, 120_000);
