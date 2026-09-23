import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { REVIEWABLE_POLARITIES } from "@/api/handlers/case-law/polarity/consts";

const MIGRATION =
  "../../drizzle/20260924140000_case_law_citation_reviews/migration.sql";

const DECISION_ID = "00000000-0000-7000-8000-000000000001";

test("the citation reviews migration applies with its keys, values and grants", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE ROLE stella_ingestion;
    GRANT ALL ON SCHEMA public TO stella, stella_ingestion;
    CREATE TABLE case_law_decisions (id uuid PRIMARY KEY);
    INSERT INTO case_law_decisions VALUES ('${DECISION_ID}');
  `);
  await db.exec(await Bun.file(new URL(MIGRATION, import.meta.url)).text());

  const privileges = async (role: string) =>
    (
      await db.query<{ privilege: string }>(
        `SELECT privilege FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege
          WHERE has_table_privilege('${role}', 'case_law_citation_reviews', privilege)`,
      )
    ).rows.map((row) => row.privilege);
  expect(await privileges("stella")).toEqual([]);
  expect(await privileges("stella_ingestion")).toEqual(["SELECT"]);

  const insert = async (polarity: string, key = "21 Cdo 1234/2020") =>
    await db.query(
      `INSERT INTO case_law_citation_reviews
         (id, citing_decision_id, citation_key, polarity, review_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, 'ref')`,
      [DECISION_ID, key, polarity],
    );
  const failureOf = async (write: Promise<unknown>): Promise<string> =>
    await write.then(
      () => "admitted",
      (error: unknown) => (error instanceof Error ? error.message : "rejected"),
    );
  for (const [index, polarity] of REVIEWABLE_POLARITIES.entries()) {
    await insert(polarity, `key-${index}`);
  }
  expect(await failureOf(insert("unknown", "key-unknown"))).toContain(
    "citation_reviews_polarity_values",
  );
  expect(await failureOf(insert("positive", "key-0"))).toContain(
    "case_law_citation_reviews_citation_idx",
  );

  await db.exec(`DELETE FROM case_law_decisions WHERE id = '${DECISION_ID}'`);
  expect(
    (await db.query("SELECT count(*)::int AS n FROM case_law_citation_reviews"))
      .rows,
  ).toEqual([{ n: 0 }]);
});
