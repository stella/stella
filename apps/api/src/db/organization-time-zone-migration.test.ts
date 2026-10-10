import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

test("the organization time zone migration adds a nullable column and rewrites no row", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE TABLE organization_settings (
      id uuid PRIMARY KEY,
      organization_id text NOT NULL UNIQUE,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO organization_settings (id, organization_id, updated_at)
    VALUES ('00000000-0000-4000-8000-000000000001', 'org-a', '2026-01-01T00:00:00Z');
  `);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261004100000_organization_time_zone/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );

  expect(
    (
      await db.query(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'organization_settings' AND column_name = 'time_zone'",
      )
    ).rows,
  ).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
  // The default is derived at read time, so existing rows stay untouched.
  expect(
    (
      await db.query(
        "SELECT time_zone, updated_at = '2026-01-01T00:00:00Z' AS untouched FROM organization_settings",
      )
    ).rows,
  ).toEqual([{ time_zone: null, untouched: true }]);
  await db.exec(
    "UPDATE organization_settings SET time_zone = 'Europe/Prague' WHERE organization_id = 'org-a'",
  );
  expect(
    (await db.query("SELECT time_zone FROM organization_settings")).rows,
  ).toEqual([{ time_zone: "Europe/Prague" }]);
}, 90_000);
