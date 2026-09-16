import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

const migration = async (path: string) =>
  await Bun.file(new URL(path, import.meta.url)).text();

test("entity view migration grants CRUD access and preserves user/org RLS", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    INSERT INTO organization VALUES ('team-a'), ('team-b');
    INSERT INTO "user" VALUES ('user-a'), ('user-b');
  `);

  await db.exec(
    await migration("../../drizzle/20260916100000_entity_views/migration.sql"),
  );
  expect(
    (
      await db.query(
        "SELECT bool_and(has_table_privilege('stella', 'entity_views', privilege)) AS allowed FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege",
      )
    ).rows,
  ).toEqual([{ allowed: false }]);

  await db.exec(
    await migration(
      "../../drizzle/20260916100100_entity_views_grants/migration.sql",
    ),
  );
  expect(
    (
      await db.query(
        "SELECT bool_and(has_table_privilege('stella', 'entity_views', privilege)) AS allowed FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege",
      )
    ).rows,
  ).toEqual([{ allowed: true }]);

  await db.exec(`
    INSERT INTO entity_views (id, organization_id, user_id, name, layout, position)
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'team-a', 'user-a', 'private-a', '{"version": 1}', 0),
      ('00000000-0000-4000-8000-000000000002', 'team-a', 'user-b', 'private-b', '{"version": 1}', 0),
      ('00000000-0000-4000-8000-000000000003', 'team-b', 'user-a', 'other-org', '{"version": 1}', 0);
    SET ROLE stella;
    SET app.organization_id = 'team-a';
    SET app.user_id = 'user-a';
  `);

  expect((await db.query("SELECT name FROM entity_views")).rows).toEqual([
    { name: "private-a" },
  ]);
  expect(
    (await db.query("UPDATE entity_views SET name = 'leak' RETURNING name"))
      .rows,
  ).toEqual([{ name: "leak" }]);
  expect((await db.query("SELECT name FROM entity_views")).rows).toEqual([
    { name: "leak" },
  ]);

  await db.exec("SET app.user_id = 'user-b';");
  expect((await db.query("SELECT name FROM entity_views")).rows).toEqual([
    { name: "private-b" },
  ]);
  await db.exec("SET app.organization_id = 'team-b';");
  expect((await db.query("SELECT name FROM entity_views")).rows).toEqual([]);
});
