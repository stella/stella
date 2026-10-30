import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";

import { caseLawDecisions } from "@/api/db/schema";

import { nssPublisherColumns } from "./nss-publisher-columns";

test("publisher columns retain text verbatim and leave absent values nullable", () => {
  const columns = nssPublisherColumns({
    nssReporterNumber: "003540",
    nssRegistryReferralDate: "26.5.2016",
    nssRegistryAnnotation: "Pravomoc rozšířeného senátu",
  });
  expect(columns.nssReporterNumber).toBe("003540");
  expect(columns.nssRegistryReferralDate).toBe("26.5.2016");
  expect(columns.nssRegistryAnnotation).toBe("Pravomoc rozšířeného senátu");
  expect(columns.nssReporterYear).toBeNull();
  expect(() => nssPublisherColumns({ nssRegistryStatus: 42 })).toThrow(
    "NSS publisher metadata nssRegistryStatus must be text",
  );
});

test("every publisher projection has a nullable SQL column and paired view columns", async () => {
  const migrationRoot = new URL("../../../../../drizzle/", import.meta.url);
  const migration = readdirSync(migrationRoot).find((name) =>
    name.endsWith("_cz_nss_publisher_fields"),
  );
  if (migration === undefined) {
    return panic("NSS publisher migration is missing");
  }
  const migrationSql = readFileSync(
    new URL(`${migration}/migration.sql`, migrationRoot),
    "utf-8",
  ).replaceAll("--> statement-breakpoint", "");
  const projected = nssPublisherColumns({});
  const expectedNames = Object.entries(getColumns(caseLawDecisions))
    .filter(([key]) => Object.hasOwn(projected, key))
    .map(([, column]) => column.name)
    .toSorted();
  expect(expectedNames.length).toBe(Object.keys(projected).length);
  const database = new PGlite();
  try {
    await database.exec(
      "CREATE TABLE case_law_decisions (metadata jsonb, redacted_at timestamptz)",
    );
    await database.exec(migrationSql);
    const columns = await database.query<{
      name: string;
      required: boolean;
      type: string;
    }>(
      `
      SELECT attname AS name, attnotnull AS required, format_type(atttypid, atttypmod) AS type
      FROM pg_attribute WHERE attrelid = 'case_law_decisions'::regclass
        AND attname = ANY($1::text[]) ORDER BY attname`,
      [expectedNames],
    );
    expect(columns.rows).toEqual(
      expectedNames.map((name) => ({ name, required: false, type: "text" })),
    );
    const views = await database.query<{ view_name: string; name: string }>(
      `
      SELECT table_name AS view_name, column_name AS name FROM information_schema.columns
      WHERE table_name IN ('case_law_published_decisions', 'case_law_unredacted_decisions')
        AND column_name = ANY($1::text[]) ORDER BY table_name, column_name`,
      [expectedNames],
    );
    expect(views.rows).toEqual(
      ["case_law_published_decisions", "case_law_unredacted_decisions"].flatMap(
        (view_name) => expectedNames.map((name) => ({ view_name, name })),
      ),
    );
  } finally {
    await database.close();
  }
});
