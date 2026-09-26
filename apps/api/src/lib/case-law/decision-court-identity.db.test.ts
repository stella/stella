import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { CASE_LAW_DECISION_COURT_ID_CONSTRAINT } from "@/api/lib/case-law/decision-court-id-sql";
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
});
