import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

const originalMigration = new URL(
  "../../drizzle/20260728120000_sharepoint_connections/migration.sql",
  import.meta.url,
);
const calendarMigration = new URL(
  "../../drizzle/20261029180445_sharepoint_calendar_capability/migration.sql",
  import.meta.url,
);

test("old disable writes clear calendar policy while org-bound selective writes retain it", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE organization_settings (organization_id varchar(128) PRIMARY KEY);
    CREATE TABLE entity_versions (id uuid PRIMARY KEY);
    INSERT INTO organization VALUES ('org-a'), ('org-b');
    INSERT INTO "user" VALUES ('user-a');
    INSERT INTO organization_settings VALUES ('org-a'), ('org-b');
  `);
  await db.exec(await Bun.file(originalMigration).text());
  await db.exec(`
    INSERT INTO sharepoint_connections (
      id, organization_id, user_id, access_token_encrypted, access_token_iv,
      status, scope
    ) VALUES (
      '00000000-0000-7000-8000-000000000001', 'org-a', 'user-a',
      decode('010203', 'hex'), decode('040506', 'hex'), 'connected',
      'Files.Read.All Sites.Read.All'
    );
    INSERT INTO sharepoint_oauth_state (
      state, organization_id, user_id, code_verifier, redirect_uri
    ) VALUES (
      'state-a', 'org-a', 'user-a', 'verifier-a',
      'https://api.example.test/v1/sharepoint/oauth/callback'
    );
  `);
  const connectionBefore = (
    await db.query("SELECT * FROM sharepoint_connections")
  ).rows;
  const stateBefore = (await db.query("SELECT * FROM sharepoint_oauth_state"))
    .rows;
  await db.exec(`BEGIN;\n${await Bun.file(calendarMigration).text()}\nCOMMIT;`);
  expect(
    (
      await db.query(`
        SELECT relname, relforcerowsecurity
          FROM pg_catalog.pg_class
         WHERE relname IN ('sharepoint_connections', 'sharepoint_oauth_state')
         ORDER BY relname
      `)
    ).rows,
  ).toEqual([
    { relname: "sharepoint_connections", relforcerowsecurity: true },
    { relname: "sharepoint_oauth_state", relforcerowsecurity: true },
  ]);
  expect((await db.query("SELECT * FROM sharepoint_connections")).rows).toEqual(
    connectionBefore,
  );
  expect((await db.query("SELECT * FROM sharepoint_oauth_state")).rows).toEqual(
    stateBefore.map((row) => ({
      ...(typeof row === "object" && row !== null ? row : {}),
      requested_scope: null,
    })),
  );

  // FORCE RLS also applies to a non-bypass table owner. Its exact owner
  // policy must retain token cleanup without granting the application role
  // another user's credential access.
  await db.exec(`
    CREATE ROLE sharepoint_test_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    ALTER TABLE sharepoint_connections OWNER TO sharepoint_test_owner;
    ALTER TABLE sharepoint_oauth_state OWNER TO sharepoint_test_owner;
    BEGIN;
    SET LOCAL ROLE sharepoint_test_owner;
  `);
  expect(
    (
      await db.query(`
        SELECT rolsuper, rolbypassrls
          FROM pg_catalog.pg_roles WHERE rolname = current_user
      `)
    ).rows,
  ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  expect(
    (await db.query("DELETE FROM sharepoint_connections RETURNING id")).rows,
  ).toHaveLength(1);
  expect(
    (await db.query("DELETE FROM sharepoint_oauth_state RETURNING state")).rows,
  ).toHaveLength(1);
  await db.exec("ROLLBACK;");

  await db.exec(`
    UPDATE organization_settings
       SET sharepoint_connection_enabled = true,
           microsoft365_calendar_read_enabled = true;
  `);
  // New selective file-off keeps the calendar grant only for its own org.
  await db.exec(`
    BEGIN;
    SELECT set_config('app.microsoft365_capability_policy_org', 'org-a', true);
    UPDATE organization_settings
       SET sharepoint_connection_enabled = false,
           microsoft365_calendar_read_enabled = true
     WHERE organization_id = 'org-a';
    UPDATE organization_settings
       SET sharepoint_connection_enabled = false,
           microsoft365_calendar_read_enabled = true
     WHERE organization_id = 'org-b';
    COMMIT;
  `);
  expect(
    (
      await db.query(`
        SELECT organization_id, microsoft365_calendar_read_enabled
          FROM organization_settings ORDER BY organization_id
      `)
    ).rows,
  ).toEqual([
    { organization_id: "org-a", microsoft365_calendar_read_enabled: true },
    { organization_id: "org-b", microsoft365_calendar_read_enabled: false },
  ]);

  // An old binary writes false even when the file bit is already false.
  await db.exec(`
    UPDATE organization_settings
       SET sharepoint_connection_enabled = false
     WHERE organization_id = 'org-a';
  `);
  expect(
    (
      await db.query(`
        SELECT microsoft365_calendar_read_enabled
          FROM organization_settings WHERE organization_id = 'org-a'
      `)
    ).rows,
  ).toEqual([{ microsoft365_calendar_read_enabled: false }]);

  // A marker from a rolled-back transaction cannot exempt a later update.
  await db.exec(`
    UPDATE organization_settings
       SET microsoft365_calendar_read_enabled = true
     WHERE organization_id = 'org-a';
    BEGIN;
    SELECT set_config('app.microsoft365_capability_policy_org', 'org-a', true);
    ROLLBACK;
    UPDATE organization_settings
       SET sharepoint_connection_enabled = false
     WHERE organization_id = 'org-a';
  `);
  expect(
    (
      await db.query(`
        SELECT microsoft365_calendar_read_enabled
          FROM organization_settings WHERE organization_id = 'org-a'
      `)
    ).rows,
  ).toEqual([{ microsoft365_calendar_read_enabled: false }]);
});
