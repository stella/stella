import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

const migration = async () =>
  await Bun.file(
    new URL(
      "../../drizzle/20260928162000_saved_time_narratives/migration.sql",
      import.meta.url,
    ),
  ).text();

test("saved narratives are isolated by user and active organization for CRUD", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE time_entries (id uuid PRIMARY KEY, narrative text NOT NULL);
    INSERT INTO organization VALUES ('org-a'), ('org-b');
    INSERT INTO "user" VALUES ('user-a'), ('user-b');
  `);
  await db.exec(await migration());
  expect(
    (
      await db.query(
        "SELECT bool_and(has_table_privilege('stella', 'saved_time_narratives', privilege)) AS allowed FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege",
      )
    ).rows,
  ).toEqual([{ allowed: true }]);

  await db.exec(`
    SET ROLE stella;
    SET app.organization_id = 'org-a';
    SET app.user_id = 'user-a';
  `);
  const ownId = "00000000-0000-4000-8000-000000000001";
  const otherId = "00000000-0000-4000-8000-000000000002";
  const otherOrgId = "00000000-0000-4000-8000-000000000003";
  await db.query(
    "INSERT INTO saved_time_narratives (id, organization_id, user_id, name, narrative, narrative_language) VALUES ($1, 'org-a', 'user-a', 'Drafting', 'Drafted motion', 'cs-CZ')",
    [ownId],
  );
  expect(
    (
      await db.query(
        "SELECT name, narrative, narrative_language FROM saved_time_narratives",
      )
    ).rows,
  ).toEqual([
    {
      name: "Drafting",
      narrative: "Drafted motion",
      narrative_language: "cs-CZ",
    },
  ]);
  await expect(
    db.query(
      "INSERT INTO saved_time_narratives (id, organization_id, user_id, name, narrative) VALUES ($1, 'org-a', 'user-b', 'Hidden', 'Secret')",
      [otherId],
    ),
  ).rejects.toThrow(/row-level security/u);
  await expect(
    db.query(
      "INSERT INTO saved_time_narratives (id, organization_id, user_id, name, narrative) VALUES ($1, 'org-b', 'user-a', 'Hidden', 'Secret')",
      [otherOrgId],
    ),
  ).rejects.toThrow(/row-level security/u);
  await db.exec("RESET ROLE;");
  await db.query(
    "INSERT INTO saved_time_narratives (id, organization_id, user_id, name, narrative) VALUES ($1, 'org-a', 'user-b', 'Other user', 'Private')",
    [otherId],
  );
  await db.query(
    "INSERT INTO saved_time_narratives (id, organization_id, user_id, name, narrative) VALUES ($1, 'org-b', 'user-a', 'Other org', 'Private')",
    [otherOrgId],
  );
  await db.exec("SET ROLE stella;");
  expect(
    (await db.query("SELECT id FROM saved_time_narratives ORDER BY id")).rows,
  ).toEqual([{ id: ownId }]);
  expect(
    (
      await db.query(
        "UPDATE saved_time_narratives SET narrative = 'Changed' RETURNING id",
      )
    ).rows,
  ).toEqual([{ id: ownId }]);
  expect(
    (await db.query("DELETE FROM saved_time_narratives RETURNING id")).rows,
  ).toEqual([{ id: ownId }]);
  await db.exec("RESET ROLE;");
  expect(
    (await db.query("SELECT id FROM saved_time_narratives ORDER BY id")).rows,
  ).toEqual([{ id: otherId }, { id: otherOrgId }]);
});

test("time-entry narrative language is nullable and round trips", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE time_entries (id uuid PRIMARY KEY, narrative text NOT NULL);
  `);
  await db.exec(await migration());
  await db.exec(`
    INSERT INTO time_entries (id, narrative, narrative_language)
      VALUES ('00000000-0000-4000-8000-000000000001', 'Review', 'pl-PL');
  `);
  expect(
    (await db.query("SELECT narrative_language FROM time_entries")).rows,
  ).toEqual([{ narrative_language: "pl-PL" }]);
});
