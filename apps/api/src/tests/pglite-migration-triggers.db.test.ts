/**
 * Every trigger the migrations leave in place is installed in the test
 * database, so a writer that breaks one fails its tests instead of production.
 *
 * Schema push has no construct for triggers, so each one reaches the test
 * database only through an installer in `pglite-schema.ts`. The allowlist
 * names the triggers not installed yet and only shrinks: an entry that is
 * installed, or that the migrations no longer define, fails the test.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { createTestPglite } from "@/api/tests/pglite-test-db";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");

/** `table.trigger`, sorted. */
const TRIGGERS_NOT_INSTALLED_IN_TESTS = [
  "case_law_decisions.case_law_corpus_jurisdictions_country_update",
  "case_law_decisions.case_law_corpus_jurisdictions_insert",
  "case_law_decisions.case_law_decisions_corpus_country_shape",
  "case_law_decisions.case_law_decisions_legacy_corpus_mirror_settle",
  "case_law_decisions.case_law_decisions_legacy_redaction_fence",
  "case_law_decisions.case_law_decisions_projection_epoch_monotonic",
  "case_law_index_jobs.case_law_index_jobs_legacy_redaction_tombstone",
  "case_law_search_documents.case_law_search_documents_clear_preview_generation",
  "case_law_search_documents.case_law_search_documents_redaction_fence",
  "case_law_sources.case_law_sources_descriptor_shape",
  "case_law_sources.case_law_sources_legacy_checkpoint_fence",
  "chat_thread_compactions.chat_thread_compactions_address_and_queue_memory",
  "chat_thread_search_documents.chat_search_documents_clear_preview_generation",
  "contact_search_documents.contact_search_documents_clear_preview_generation",
  "corpus_index_generations.corpus_index_generations_identity_immutable",
  "corpus_index_generations.corpus_index_generations_retired_terminal",
  "corpus_index_projection_intents.corpus_index_projection_intents_delete_guard",
  "corpus_index_projection_intents.corpus_index_projection_intents_expected_document_count_guard",
  "corpus_index_projection_intents.corpus_index_projection_intents_insert_guard",
  "corpus_index_projection_intents.corpus_index_projection_intents_update_guard",
  "corpus_index_projection_states.corpus_index_projection_states_delete_guard",
  "corpus_index_projection_states.corpus_index_projection_states_guard",
  "corpus_index_projection_states.corpus_index_projection_states_work_guard",
  "entities.entities_refresh_display_name_after_write",
  "fields.fields_refresh_entity_display_name_after_write",
  "legislation_documents.legislation_documents_projection_epoch_monotonic",
  "organization_settings.organization_settings_sync_memory_extraction_queue",
  "properties.properties_derive_kinds",
  "search_documents.search_documents_clear_preview_generation",
  "workspace_search_documents.workspace_search_documents_clear_preview_generation",
  "workspaces.stella_delete_source_matter_memories",
] as const;

const NAME = String.raw`"?(\w+)"?`;
const TABLE = String.raw`(?:"?public"?\.)?"?(\w+)"?`;
const CREATE_TRIGGER = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+${NAME}[\s\S]*?\bON\s+${TABLE}`,
  "iu",
);
const DROP_TRIGGER = new RegExp(
  String.raw`^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${NAME}\s+ON\s+${TABLE}`,
  "iu",
);
const DROP_TABLE =
  /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+?)(?:\s+CASCADE)?\s*;?$/iu;

/** `table.trigger` from a match whose groups are the trigger, then the table. */
const triggerKey = (match: RegExpExecArray | null): string | undefined => {
  const trigger = match?.[1];
  const table = match?.[2];
  return trigger === undefined || table === undefined
    ? undefined
    : `${table}.${trigger}`;
};

/** The triggers left in place after every migration runs, in order. */
const triggersDefinedByMigrations = (): Set<string> => {
  const defined = new Set<string>();
  const migrations = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => nodePath.join(DRIZZLE_DIR, entry.name, "migration.sql"))
    .toSorted();
  for (const migrationPath of migrations) {
    const statements = readFileSync(migrationPath, "utf-8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^[ \t]*--[^\n]*/gmu, "").trim());
    for (const statement of statements) {
      const created = triggerKey(CREATE_TRIGGER.exec(statement));
      if (created !== undefined) {
        defined.add(created);
      }
      const dropped = triggerKey(DROP_TRIGGER.exec(statement));
      if (dropped !== undefined) {
        defined.delete(dropped);
      }
      const droppedTables = DROP_TABLE.exec(statement)?.[1];
      if (droppedTables !== undefined) {
        for (const table of droppedTables.split(",")) {
          const name = table
            .trim()
            .replaceAll('"', "")
            .replace(/^public\./u, "");
          for (const trigger of [...defined]) {
            if (trigger.startsWith(`${name}.`)) {
              defined.delete(trigger);
            }
          }
        }
      }
    }
  }
  return defined;
};

let client: PGlite;
let installed: Set<string>;
const defined = triggersDefinedByMigrations();
const allowlisted = new Set<string>(TRIGGERS_NOT_INSTALLED_IN_TESTS);

beforeAll(async () => {
  client = await createTestPglite();
  const { rows } = await client.query<{ trigger: string }>(
    `SELECT c.relname || '.' || t.tgname AS trigger
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal`,
  );
  installed = new Set(rows.map((row) => row.trigger));
}, 120_000);

afterAll(async () => {
  await client.close();
});

describe("migration triggers in the test database", () => {
  test("every trigger the migrations define is installed or allowlisted", () => {
    const missing = [...defined]
      .filter((trigger) => !installed.has(trigger) && !allowlisted.has(trigger))
      .toSorted();

    expect(
      missing,
      `Install these triggers in the test database (see pglite-schema.ts): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("the allowlist only shrinks", () => {
    const stale = [...allowlisted]
      .filter((trigger) => installed.has(trigger) || !defined.has(trigger))
      .toSorted();

    expect(
      stale,
      `These TRIGGERS_NOT_INSTALLED_IN_TESTS entries are installed now, or no longer defined by a migration: ${stale.join(", ")}. Remove them.`,
    ).toEqual([]);
  });

  test("the test database installs no trigger the migrations do not define", () => {
    const undefinedTriggers = [...installed]
      .filter((trigger) => !defined.has(trigger))
      .toSorted();

    expect(undefinedTriggers).toEqual([]);
  });

  test("the migration walk finds the triggers", () => {
    // A parser that matched nothing would satisfy every assertion above.
    expect(defined.size).toBeGreaterThan(50);
    expect(installed.size).toBeGreaterThan(25);
  });
});
