import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

test("registry credential migrations grant application access while preserving organization isolation", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id text PRIMARY KEY);
    INSERT INTO organization VALUES ('team-a'), ('team-b');
  `);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20260907140100_business_registry_credentials/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  expect(
    (
      await db.query(
        "SELECT has_table_privilege('stella', 'business_registry_credentials', 'SELECT') AS allowed",
      )
    ).rows,
  ).toEqual([{ allowed: false }]);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20260907140200_business_registry_credentials_grants/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  const privileges = await db.query(
    "SELECT bool_and(has_table_privilege('stella', 'business_registry_credentials', privilege)) AS allowed FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege",
  );
  expect(privileges.rows).toEqual([{ allowed: true }]);
  await db.exec(`
    INSERT INTO business_registry_credentials (organization_id, registry, ciphertext, iv)
    VALUES ('team-a', 'companies-house', '\\x01', '\\x02'), ('team-b', 'companies-house', '\\x03', '\\x04');
    SET ROLE stella;
    SET app.organization_id = 'team-a';
  `);
  expect(
    (
      await db.query(
        "SELECT organization_id FROM business_registry_credentials",
      )
    ).rows,
  ).toEqual([{ organization_id: "team-a" }]);
  expect(
    (
      await db.query(
        "UPDATE business_registry_credentials SET ciphertext = '\\x05' WHERE organization_id = 'team-b' RETURNING organization_id",
      )
    ).rows,
  ).toEqual([]);
}, 90_000);

test("saved company formats can be created and reused without crossing organizations", async () => {
  await using db = await PGlite.create();
  await db.exec(
    "CREATE ROLE stella; CREATE TABLE organization (id text PRIMARY KEY); INSERT INTO organization VALUES ('team-a'), ('team-b');",
  );
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20260907140000_template_lookup_formats/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  expect(
    (
      await db.query(
        "SELECT has_table_privilege('stella', 'template_lookup_formats', 'INSERT') AS allowed",
      )
    ).rows,
  ).toEqual([{ allowed: false }]);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20260907140300_template_lookup_formats_grants/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  await db.exec("SET ROLE stella; SET app.organization_id = 'team-a';");
  const saved = await db.query(
    "INSERT INTO template_lookup_formats (id, organization_id, registry, name, format) VALUES ('00000000-0000-4000-8000-000000000001', 'team-a', 'ares', 'Short specification', '[name]') RETURNING name, format",
  );
  expect(saved.rows).toEqual([
    { name: "Short specification", format: "[name]" },
  ]);
  expect(
    (await db.query("SELECT name, format FROM template_lookup_formats")).rows,
  ).toEqual(saved.rows);
  await db.exec("SET app.organization_id = 'team-b';");
  expect(
    (await db.query("SELECT name FROM template_lookup_formats")).rows,
  ).toEqual([]);
  expect(
    (await db.query("DELETE FROM template_lookup_formats RETURNING id")).rows,
  ).toEqual([]);
}, 90_000);
