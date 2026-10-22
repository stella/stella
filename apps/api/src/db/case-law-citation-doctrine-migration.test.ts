import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { DOCTRINAL_TREATMENTS } from "@/api/lib/case-law/doctrine";

const EXPAND_MIGRATION =
  "../../drizzle/20261014174500_case_law_citation_doctrine/migration.sql";
const VALIDATE_MIGRATION =
  "../../drizzle/20261014174600_validate_case_law_citation_doctrine/migration.sql";
const DECISION_ID = "00000000-0000-7000-8000-000000000001";

// Apply the committed SQL itself: the production CHECK and policy boundaries,
// rather than the schema's rendering, must admit the reviewed import.
test("doctrine migrations enforce reviewed evidence and owner-only writes", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE ROLE stella_ingestion;
    CREATE ROLE stella_public_law_reader;
    CREATE ROLE doctrine_test_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO stella, stella_ingestion, doctrine_test_owner;
    CREATE TABLE case_law_decisions (id uuid PRIMARY KEY);
    CREATE TABLE case_law_citations (id uuid PRIMARY KEY, cited_decision_id uuid);
    INSERT INTO case_law_decisions VALUES ('${DECISION_ID}');
    INSERT INTO case_law_citations VALUES ('${DECISION_ID}', '${DECISION_ID}');
  `);
  await db.exec(
    await Bun.file(new URL(EXPAND_MIGRATION, import.meta.url)).text(),
  );

  const validationState = async () =>
    (
      await db.query<{ convalidated: boolean }>(`
      SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'case_law_citations'::regclass
        AND conname = 'citations_doctrinal_treatment_values'
    `)
    ).rows;
  expect(await validationState()).toEqual([{ convalidated: false }]);
  expect(
    (await db.query("SELECT doctrinal_treatment FROM case_law_citations")).rows,
  ).toEqual([{ doctrinal_treatment: null }]);
  expect(
    await rejectionOf(
      db.exec("UPDATE case_law_citations SET doctrinal_treatment = 'unknown'"),
    ),
  ).toMatchObject({
    message: expect.stringContaining("citations_doctrinal_treatment_values"),
  });
  for (const treatment of DOCTRINAL_TREATMENTS) {
    await db.query("UPDATE case_law_citations SET doctrinal_treatment = $1", [
      treatment,
    ]);
  }
  await db.exec(
    await Bun.file(new URL(VALIDATE_MIGRATION, import.meta.url)).text(),
  );
  expect(await validationState()).toEqual([{ convalidated: true }]);

  expect(
    (
      await db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE oid = 'case_law_citation_doctrine_reviews'::regclass
  `)
    ).rows,
  ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

  const insert = async (treatment: string, evidenceQuote: string | null) =>
    await db.query(
      `
      INSERT INTO case_law_citation_doctrine_reviews
        (id, citing_decision_id, citation_key, doctrinal_treatment,
         evidence_quote, review_ref, origin)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 'review-ref', 'human-review')
    `,
      [DECISION_ID, treatment, treatment, evidenceQuote],
    );

  // A superuser bypass would hide a missing owner policy. Use a real owner
  // without BYPASSRLS so FORCE RLS participates in each imported row.
  await db.exec(`
    ALTER TABLE case_law_citation_doctrine_reviews OWNER TO doctrine_test_owner;
    SET ROLE doctrine_test_owner;
  `);
  expect(
    await rejectionOf(insert("unknown", "A verbatim passage.")),
  ).toMatchObject({
    message: expect.stringContaining(
      "citation_doctrine_reviews_treatment_values",
    ),
  });
  for (const treatment of DOCTRINAL_TREATMENTS) {
    if (treatment !== "not_stated") {
      for (const quote of [null, "", "   "]) {
        expect(await rejectionOf(insert(treatment, quote))).toMatchObject({
          message: expect.stringContaining(
            "citation_doctrine_reviews_evidence_quote_required",
          ),
        });
      }
    }
    await insert(
      treatment,
      treatment === "not_stated" ? null : "A verbatim passage.",
    );
  }
  expect(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM case_law_citation_doctrine_reviews",
      )
    ).rows,
  ).toEqual([{ count: DOCTRINAL_TREATMENTS.length }]);
  await db.exec("RESET ROLE; SET ROLE stella_ingestion;");
  expect(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM case_law_citation_doctrine_reviews",
      )
    ).rows,
  ).toEqual([{ count: DOCTRINAL_TREATMENTS.length }]);
  expect(await rejectionOf(insert("not_stated", null))).toMatchObject({
    message: expect.stringContaining(
      "permission denied for table case_law_citation_doctrine_reviews",
    ),
  });

  await db.exec("RESET ROLE; SET ROLE stella;");
  expect(
    await rejectionOf(
      db.query("SELECT * FROM case_law_citation_doctrine_reviews"),
    ),
  ).toMatchObject({
    message: expect.stringContaining(
      "permission denied for table case_law_citation_doctrine_reviews",
    ),
  });
  await db.exec(`
    RESET ROLE;
    GRANT SELECT, INSERT ON case_law_citation_doctrine_reviews TO stella;
    SET ROLE stella;
  `);
  // A mistaken future grant must still leave the request role outside RLS.
  expect(
    (await db.query("SELECT * FROM case_law_citation_doctrine_reviews")).rows,
  ).toEqual([]);
  expect(await rejectionOf(insert("not_stated", null))).toMatchObject({
    message: expect.stringContaining("row-level security policy for table"),
  });
  await db.exec("RESET ROLE");
});
