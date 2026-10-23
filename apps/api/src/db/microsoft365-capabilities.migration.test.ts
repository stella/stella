import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import {
  microsoft365Connections,
  microsoft365OAuthState,
} from "@/api/db/schema";

const MIGRATIONS = [
  "../../drizzle/20260728120000_sharepoint_connections/migration.sql",
  "../../drizzle/20261020093100_microsoft365_capabilities/migration.sql",
] as const;

const migrationSql = async (relative: string): Promise<string> =>
  await Bun.file(new URL(relative, import.meta.url)).text();

test("Microsoft 365 capability migration preserves delegated rows and maps file opt-in", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE organization_settings (organization_id varchar(128) PRIMARY KEY);
    CREATE TABLE entity_versions (id uuid PRIMARY KEY);
    INSERT INTO organization VALUES ('org-enabled'), ('org-disabled');
    INSERT INTO "user" VALUES ('user-1');
    INSERT INTO organization_settings (organization_id)
      VALUES ('org-enabled'), ('org-disabled');
  `);

  const [original, capabilities] = MIGRATIONS;
  await db.exec(await migrationSql(original));
  await db.exec(`
    INSERT INTO sharepoint_connections (
      id, organization_id, user_id, access_token_encrypted, access_token_iv,
      refresh_token_encrypted, refresh_token_iv, token_type, scope, account_label,
      expires_at, status, last_used_at
    ) VALUES (
      '00000000-0000-7000-8000-000000000001', 'org-enabled', 'user-1',
      decode('010203', 'hex'), decode('040506', 'hex'), decode('070809', 'hex'),
      decode('0a0b0c', 'hex'), 'Bearer', 'Files.Read.All Sites.Read.All',
      'user@example.test', '2026-10-22T10:00:00Z', 'connected',
      '2026-10-22T09:00:00Z'
    );
    INSERT INTO sharepoint_oauth_state (
      state, organization_id, user_id, code_verifier, redirect_uri
    ) VALUES (
      'state-1', 'org-enabled', 'user-1', 'verifier-1',
      'https://example.test/oauth/callback'
    );
    UPDATE organization_settings
      SET sharepoint_connection_enabled = true
      WHERE organization_id = 'org-enabled';
  `);

  const connectionsBefore = (
    await db.query("SELECT * FROM sharepoint_connections ORDER BY id")
  ).rows;
  const oauthStateBefore = (
    await db.query("SELECT * FROM sharepoint_oauth_state ORDER BY state")
  ).rows;

  await db.exec(await migrationSql(capabilities));

  expect(getTableName(microsoft365Connections)).toBe("sharepoint_connections");
  expect(getTableName(microsoft365OAuthState)).toBe("sharepoint_oauth_state");
  expect(
    (await db.query("SELECT * FROM sharepoint_connections ORDER BY id")).rows,
  ).toEqual(connectionsBefore);
  expect(
    (await db.query("SELECT * FROM sharepoint_oauth_state ORDER BY state"))
      .rows,
  ).toEqual(
    oauthStateBefore.map((row) => ({
      ...(typeof row === "object" && row !== null ? row : {}),
      requested_scope: null,
    })),
  );
  expect(
    (
      await db.query(
        `SELECT organization_id, microsoft365_files_read_enabled,
                microsoft365_calendar_read_enabled
           FROM organization_settings ORDER BY organization_id`,
      )
    ).rows,
  ).toEqual([
    {
      organization_id: "org-disabled",
      microsoft365_files_read_enabled: false,
      microsoft365_calendar_read_enabled: false,
    },
    {
      organization_id: "org-enabled",
      microsoft365_files_read_enabled: true,
      microsoft365_calendar_read_enabled: false,
    },
  ]);
});
