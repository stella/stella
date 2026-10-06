import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { caseLawSources } from "@/api/db/schema";

test("source lease purposes preserve existing owners and restrict persisted values", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella_ingestion;
    CREATE TABLE case_law_sources (
      id integer PRIMARY KEY,
      ingestion_lease_token uuid,
      ingestion_lease_expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z'
    );
    INSERT INTO case_law_sources (id, ingestion_lease_token, ingestion_lease_expires_at)
    VALUES (1, '00000000-0000-4000-8000-000000000001', '2100-01-01T00:00:00Z'), (2, null, null);
  `);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261005184900_case_law_source_lease_purpose/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  expect(
    (
      await db.query(`SELECT convalidated AS validated FROM pg_constraint
        WHERE conname = 'case_law_sources_ingestion_lease_purpose_valid'`)
    ).rows,
  ).toEqual([{ validated: false }]);
  await db.exec("BEGIN");
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261005185000_case_law_source_lease_purpose_validate/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  await db.exec("COMMIT");
  expect(
    (
      await db.query(`SELECT convalidated AS validated FROM pg_constraint
        WHERE conname = 'case_law_sources_ingestion_lease_purpose_valid'`)
    ).rows,
  ).toEqual([{ validated: true }]);
  expect(
    (
      await db.query(`SELECT ingestion_lease_purpose AS purpose,
      ingestion_lease_token IS NOT NULL AS held,
      CASE WHEN id = 1 THEN ingestion_lease_token = '00000000-0000-4000-8000-000000000001'::uuid
        AND ingestion_lease_expires_at = '2100-01-01T00:00:00Z'
        ELSE ingestion_lease_token IS NULL AND ingestion_lease_expires_at IS NULL END AS owner_unchanged,
      updated_at = '2026-01-01T00:00:00Z' AS untouched
    FROM case_law_sources ORDER BY id`)
    ).rows,
  ).toEqual([
    {
      purpose: "ingestion",
      held: true,
      owner_unchanged: true,
      untouched: true,
    },
    {
      purpose: "ingestion",
      held: false,
      owner_unchanged: true,
      untouched: true,
    },
  ]);
  expect(caseLawSources.ingestionLeasePurpose.enumValues).toEqual([
    "ingestion",
    "decision-merge",
  ]);
  for (const purpose of caseLawSources.ingestionLeasePurpose.enumValues) {
    await db.query(
      "UPDATE case_law_sources SET ingestion_lease_purpose = $1 WHERE id = 2",
      [purpose],
    );
    expect(
      (
        await db.query(
          "SELECT ingestion_lease_purpose AS purpose FROM case_law_sources WHERE id = 2",
        )
      ).rows,
    ).toEqual([{ purpose }]);
  }
  await rejectionOf(
    db.exec(
      "UPDATE case_law_sources SET ingestion_lease_purpose = 'unregistered' WHERE id = 2",
    ),
  );
  await rejectionOf(
    db.exec(
      "UPDATE case_law_sources SET ingestion_lease_purpose = null WHERE id = 2",
    ),
  );
  await db.exec("INSERT INTO case_law_sources (id) VALUES (3)");
  expect(
    (
      await db.query(
        "SELECT ingestion_lease_purpose AS purpose, decision_merge_epoch::text AS epoch FROM case_law_sources WHERE id = 3",
      )
    ).rows,
  ).toEqual([{ purpose: "ingestion", epoch: "0" }]);
  for (const column of ["ingestion_lease_purpose", "decision_merge_epoch"]) {
    expect(
      (
        await db.query(
          `SELECT has_column_privilege('stella_ingestion', 'case_law_sources', $1, 'UPDATE') AS allowed`,
          [column],
        )
      ).rows,
    ).toEqual([{ allowed: true }]);
  }
}, 90_000);
