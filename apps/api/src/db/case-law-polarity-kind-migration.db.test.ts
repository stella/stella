import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { rejectionOf } from "@stll/property-testing/rejection";

const migration = readFileSync(
  new URL(
    "../../drizzle/20261016100100_case_law_polarity_kind_evidence/migration.sql",
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

const reviewRevisionMigration = readFileSync(
  new URL(
    "../../drizzle/20261016100300_case_law_review_text_revision/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const reviewRevisionValidation = readFileSync(
  new URL(
    "../../drizzle/20261016100400_case_law_review_text_revision_validate/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

test("stance and doctrine reviews accept only nullable SHA-256 text revisions", async () => {
  await using database = new PGlite();
  await database.exec(`
    CREATE TABLE case_law_citation_reviews (id text);
    CREATE TABLE case_law_citation_doctrine_reviews (id text);
  `);
  await database.exec(reviewRevisionMigration);
  await database.exec(reviewRevisionValidation);
  for (const table of [
    "case_law_citation_reviews",
    "case_law_citation_doctrine_reviews",
  ]) {
    await database.exec(`INSERT INTO ${table} (id) VALUES ('legacy')`);
    await database.query(
      `INSERT INTO ${table} (id, text_revision_sha256) VALUES ($1, $2)`,
      ["current", "a".repeat(64)],
    );
    expect(
      await rejectionOf(
        database.query(
          `INSERT INTO ${table} (id, text_revision_sha256) VALUES ($1, $2)`,
          ["invalid", "malformed"],
        ),
      ),
    ).toHaveProperty("code", "23514");
  }
});
