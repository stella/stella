import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../../drizzle/20261010005100_case_law_polarity_kind_evidence/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

test("rule inserts without kind retain the stance default during rollout", async () => {
  await using database = new PGlite();
  await database.exec(`
    CREATE TABLE case_law_polarity_rules (
      pattern text NOT NULL, language text NOT NULL, polarity text NOT NULL
    );
    CREATE TABLE case_law_citations (id text);
  `);
  await database.exec(migration);
  await database.exec(`
    INSERT INTO case_law_polarity_rules (pattern, language, polarity)
    VALUES ('new-rule', 'xx', 'supportive');
  `);

  const result = await database.query<{ kind: string; polarity: string }>(
    "SELECT kind, polarity FROM case_law_polarity_rules",
  );
  expect(result.rows).toEqual([{ kind: "stance", polarity: "supportive" }]);
});
