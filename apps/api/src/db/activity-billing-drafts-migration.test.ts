import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  billingDraftUserSettings,
  billingGuidelineFiles,
} from "./schema/billing-drafts";

const resourceId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";

const createDatabase = async () => {
  const db = await PGlite.create({ extensions: { pg_trgm } });
  await db.exec(`
    CREATE EXTENSION pg_trgm;
    CREATE ROLE stella;
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE member (organization_id text, user_id text, role text);
    CREATE TABLE organization_settings (id uuid PRIMARY KEY, organization_id text);
    CREATE TABLE contacts (id uuid PRIMARY KEY, organization_id text);
    CREATE TABLE workspaces (id uuid PRIMARY KEY);
    CREATE TABLE agent_skill_resources (id uuid PRIMARY KEY, path text);
    INSERT INTO organization VALUES ('org-a'), ('org-b');
    INSERT INTO "user" VALUES ('user-admin'), ('user-member'), ('user-other');
    INSERT INTO member VALUES ('org-a', 'user-admin', 'admin'), ('org-a', 'user-member', 'member');
    INSERT INTO contacts VALUES ('${clientId}', 'org-a');
    INSERT INTO agent_skill_resources (id, path) VALUES ('${resourceId}', 'knowledge/billing.md');
    GRANT SELECT ON member TO stella;
  `);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261010103000_activity_billing_drafts/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  return db;
};

test("billing draft migration matches declared columns and defaults to an off gate", async () => {
  await using db = await createDatabase();
  for (const table of [billingDraftUserSettings, billingGuidelineFiles]) {
    const definition = getTableConfig(table);
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
      [definition.name],
    );
    expect(columns.rows.map((column) => column.column_name)).toEqual(
      definition.columns.map((column) => column.name),
    );
  }
  await db.exec(
    "INSERT INTO organization_settings (id, organization_id) VALUES ('00000000-0000-4000-8000-000000000003', 'org-a');",
  );
  expect(
    (await db.query("SELECT ai_billing_drafts_mode FROM organization_settings"))
      .rows,
  ).toEqual([{ ai_billing_drafts_mode: "disabled" }]);
  expect(
    (
      await db.query(
        "SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'billing_narrative_language'",
      )
    ).rows,
  ).toEqual([{ character_maximum_length: 64 }]);
  const invalidMode = await Result.tryPromise(
    async () =>
      await db.exec(
        "UPDATE organization_settings SET ai_billing_drafts_mode = 'automatic'",
      ),
  );
  expect(invalidMode.isErr()).toBe(true);
  if (invalidMode.isErr()) {
    expect(invalidMode.error.message).toContain(
      "organization_settings_ai_billing_drafts_mode_check",
    );
  }
});

test("migrated guideline writes require current firm administration and personal preferences stay private", async () => {
  await using db = await createDatabase();
  await db.exec(
    "SET ROLE stella; SET app.organization_id = 'org-a'; SET app.user_id = 'user-member';",
  );
  const denied = await Result.tryPromise(
    async () =>
      await db.query(
        "INSERT INTO billing_guideline_files (organization_id, resource_id, client_id) VALUES ('org-a', $1, $2)",
        [resourceId, clientId],
      ),
  );
  expect(denied.isErr()).toBe(true);
  if (denied.isErr()) {
    expect(denied.error.message).toMatch(/row-level security/u);
  }
  await db.exec("SET app.user_id = 'user-admin';");
  await db.query(
    "INSERT INTO billing_guideline_files (organization_id, resource_id, client_id) VALUES ('org-a', $1, $2)",
    [resourceId, clientId],
  );
  await db.exec(
    "INSERT INTO billing_draft_user_settings (user_id, preference) VALUES ('user-admin', 'Concise'); SET app.user_id = 'user-member';",
  );
  expect(
    (await db.query("SELECT * FROM billing_draft_user_settings")).rows,
  ).toEqual([]);
  expect(
    (
      await db.query(
        "DELETE FROM billing_guideline_files RETURNING resource_id",
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.query(
        "UPDATE billing_guideline_files SET client_id = NULL RETURNING resource_id",
      )
    ).rows,
  ).toEqual([]);
  expect(
    (await db.query("SELECT resource_id FROM billing_guideline_files")).rows,
  ).toEqual([{ resource_id: resourceId }]);
  await db.exec(
    "SET app.organization_id = 'org-b'; SET app.user_id = 'user-admin';",
  );
  expect(
    (await db.query("SELECT resource_id FROM billing_guideline_files")).rows,
  ).toEqual([]);
  const foreignPreference = await Result.tryPromise(
    async () =>
      await db.exec(
        "INSERT INTO billing_draft_user_settings (user_id, preference) VALUES ('user-other', 'Private')",
      ),
  );
  expect(foreignPreference.isErr()).toBe(true);
  if (foreignPreference.isErr()) {
    expect(foreignPreference.error.message).toMatch(/row-level security/u);
  }
});
