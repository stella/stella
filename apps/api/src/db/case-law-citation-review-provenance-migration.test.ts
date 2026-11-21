import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import {
  AI_CITATION_REVIEW_ORIGINS,
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGINS,
} from "@/api/handlers/case-law/polarity/consts";

const MIGRATIONS = [
  "../../drizzle/20260924140000_case_law_citation_reviews/migration.sql",
  "../../drizzle/20261007090000_case_law_citation_review_provenance/migration.sql",
  "../../drizzle/20261007090100_validate_case_law_citation_review_provenance/migration.sql",
] as const;

const DECISION_ID = "00000000-0000-7000-8000-000000000001";
const DIGEST = "a".repeat(64);

const PROVENANCE = {
  model: "model-1",
  prompt_version: "v1",
  prompt_sha256: DIGEST,
  evidence_sha256: DIGEST,
  run_id: "run-1",
  produced_at: "2026-10-07T08:00:00Z",
} as const;

type ProvenanceColumn = keyof typeof PROVENANCE;

const PROVENANCE_COLUMNS = Object.keys(PROVENANCE).filter(
  (column): column is ProvenanceColumn => column in PROVENANCE,
);

const migrationSql = async (relative: string): Promise<string> =>
  await Bun.file(new URL(relative, import.meta.url)).text();

const failureOf = async (write: Promise<unknown>): Promise<string> =>
  await write.then(
    () => "admitted",
    (error: unknown) => (error instanceof Error ? error.message : "rejected"),
  );

test("existing reviews become human reviews and provenance follows the origin", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE ROLE stella_ingestion;
    GRANT ALL ON SCHEMA public TO stella, stella_ingestion;
    CREATE TABLE case_law_decisions (id uuid PRIMARY KEY);
    INSERT INTO case_law_decisions VALUES ('${DECISION_ID}');
  `);
  const [created, provenance, validate] = MIGRATIONS;
  await db.exec(await migrationSql(created));
  await db.query(
    `INSERT INTO case_law_citation_reviews
       (id, citing_decision_id, citation_key, polarity, review_ref)
     VALUES (gen_random_uuid(), $1, 'stored-before', 'negative', 'ref')`,
    [DECISION_ID],
  );
  await db.exec(await migrationSql(provenance));
  await db.exec(await migrationSql(validate));

  expect(
    (
      await db.query(
        `SELECT origin, model, prompt_version, prompt_sha256, evidence_sha256, run_id, produced_at
           FROM case_law_citation_reviews`,
      )
    ).rows,
  ).toEqual([
    {
      origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      model: null,
      prompt_version: null,
      prompt_sha256: null,
      evidence_sha256: null,
      run_id: null,
      produced_at: null,
    },
  ]);
  expect(
    (
      await db.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conname IN ('citation_reviews_origin_values', 'citation_reviews_origin_provenance')
          ORDER BY conname`,
      )
    ).rows,
  ).toEqual([
    { conname: "citation_reviews_origin_provenance", convalidated: true },
    { conname: "citation_reviews_origin_values", convalidated: true },
  ]);

  let keys = 0;
  const insert = async (
    origin: string | null,
    columns: Partial<Record<ProvenanceColumn, string>>,
  ) => {
    keys += 1;
    const names = Object.keys(columns);
    const values = Object.values(columns);
    return await db.query(
      `INSERT INTO case_law_citation_reviews
         (id, citing_decision_id, citation_key, polarity, review_ref, origin${names.map((name) => `, ${name}`).join("")})
       VALUES (gen_random_uuid(), $1, $2, 'positive', 'ref', $3${values.map((_, index) => `, $${index + 4}`).join("")})`,
      [DECISION_ID, `key-${keys}`, origin, ...values],
    );
  };

  // The backfill default is gone: a writer has to name the origin.
  expect(await failureOf(insert(null, {}))).toContain(
    'null value in column "origin"',
  );
  // An undeclared origin is in neither check's list; either may report it.
  for (const columns of [{}, PROVENANCE]) {
    expect(await failureOf(insert("model-review", columns))).toMatch(
      /citation_reviews_origin_(values|provenance)/u,
    );
  }
  expect(await failureOf(insert(CITATION_REVIEW_ORIGIN.HUMAN_REVIEW, {}))).toBe(
    "admitted",
  );
  for (const column of PROVENANCE_COLUMNS) {
    expect(
      await failureOf(
        insert(CITATION_REVIEW_ORIGIN.HUMAN_REVIEW, {
          [column]: PROVENANCE[column],
        }),
      ),
    ).toContain("citation_reviews_origin_provenance");
  }
  for (const origin of AI_CITATION_REVIEW_ORIGINS) {
    expect(await failureOf(insert(origin, PROVENANCE))).toBe("admitted");
    for (const column of PROVENANCE_COLUMNS) {
      const { [column]: _missing, ...partial } = PROVENANCE;
      expect(await failureOf(insert(origin, partial))).toContain(
        "citation_reviews_origin_provenance",
      );
    }
  }
  // Every declared origin was admitted with the provenance it requires.
  expect(
    (
      await db.query<{ origin: string }>(
        "SELECT DISTINCT origin FROM case_law_citation_reviews ORDER BY origin",
      )
    ).rows.map((row) => row.origin),
  ).toEqual(CITATION_REVIEW_ORIGINS.toSorted());
});
