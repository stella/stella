import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

const MIGRATION = new URL(
  "../../../drizzle/20260825136200_corpus_watermark_delete_grants/migration.sql",
  import.meta.url,
);
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

test("the ingestion role can retire case-law and legislation watermarks", async () => {
  const client = await PGlite.create();
  try {
    await client.exec(`
      CREATE ROLE stella_ingestion;
      CREATE TABLE case_law_corpus_index_delete_watermarks (
        index_id varchar(64) PRIMARY KEY
      );
      CREATE TABLE legislation_corpus_index_delete_watermarks (
        index_id varchar(64) PRIMARY KEY
      );
      INSERT INTO case_law_corpus_index_delete_watermarks VALUES ('case_law_v4_cs_sk');
      INSERT INTO legislation_corpus_index_delete_watermarks VALUES ('legislation_v1_cz');
    `);
    const migration = (await Bun.file(MIGRATION).text()).replaceAll(
      STATEMENT_BREAKPOINT,
      "",
    );
    await client.exec(migration);

    await client.exec(`
      SET ROLE stella_ingestion;
      DELETE FROM case_law_corpus_index_delete_watermarks;
      DELETE FROM legislation_corpus_index_delete_watermarks;
      RESET ROLE;
    `);

    const caseLaw = await client.query(
      "SELECT index_id FROM case_law_corpus_index_delete_watermarks",
    );
    const legislation = await client.query(
      "SELECT index_id FROM legislation_corpus_index_delete_watermarks",
    );
    expect(caseLaw.rows).toEqual([]);
    expect(legislation.rows).toEqual([]);
  } finally {
    await client.close();
  }
});
