import { panic, Result } from "better-result";
import type { ReservedSQL, SQL } from "bun";
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";

import { buildBetterAuthOAuthResources } from "@/api/mcp/resource-policy-contract";

import { contendSession } from "../../../../scripts/migration-rehearsal-contender";
import type { WriterEvent } from "../../../../scripts/migration-rehearsal-writer-gap";
import {
  judgeWriterGap,
  writerGapReport,
} from "../../../../scripts/migration-rehearsal-writer-gap";
import { withGatedTestClients } from "../tests/gated-test-database";
import { createUngatedTableGateForTests } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";
import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";
import { terminateReserved } from "./sql-close";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const templateDatabase = process.env["STELLA_TEST_TEMPLATE_DATABASE"];
const DEADLINE_MS = 30_000;
const GAP_BUDGET_SECONDS = 2;
const WRITER_HOLD_MS = 10;
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const ID = "00000000-0000-4000-8000-000000000001";
const ID_2 = "00000000-0000-4000-8000-000000000002";
const ID_3 = "00000000-0000-4000-8000-000000000003";
/** A Czech VAT number in the legacy tax_id column; synthetic. */
const VAT_ID = "CZ12345678";
const READER_ANNOTATION_INSERT = `INSERT INTO legal_reader_annotations (id, organization_id, user_id, target_type, target_id, kind, visibility, color, style, block_anchor_id, start_offset, end_offset, quote) VALUES ('${ID}', 'org', 'user', 'statute', '${ID_2}', 'highlight', 'private', 'yellow', 'highlight', 'p-1', 0, 5, 'words')`;

if (enabled && templateDatabase === undefined) {
  panic(
    "STELLA_TEST_TEMPLATE_DATABASE is required when the online-repairs PostgreSQL suite is enabled; run it through test:postgres",
  );
}

// timeout: Migrated scratch databases exercise a 30 s repair deadline and drain concurrent PostgreSQL writers before dropping the database.
setDefaultTimeout(120_000);

type RepairName = (typeof ONLINE_MIGRATION_REPAIRS)[number]["name"];
type RowSeed = {
  kind: "row-work";
  assertPending: (client: SQL, id: string) => Promise<void>;
  assertRepaired: (client: SQL, id: string) => Promise<void>;
  seed: (client: SQL) => Promise<void>;
  writerLock: { id: string; table: string };
};
type NoRowSeed = {
  kind: "no-row-work";
  seed: (client: SQL) => Promise<void>;
  snapshot: (client: SQL) => Promise<Record<string, string[]>>;
  tables: readonly string[];
};
type Seed = RowSeed | NoRowSeed;

const exec = async (client: SQL, statements: readonly string[]) => {
  for (const statement of statements) {
    await client.unsafe(statement);
  }
};

const invalidateConstraint = async (
  client: SQL,
  table: string,
  constraint: string,
  whileAbsent?: () => Promise<void>,
) => {
  const definition = await client<
    { definition: string }[]
  >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ${`public.${table}`}::regclass AND conname = ${constraint}`;
  const value = definition.at(0)?.definition;
  if (value === undefined) {
    panic(`Missing fixture constraint ${constraint}`);
  }
  await client.unsafe(
    `ALTER TABLE public."${table}" DROP CONSTRAINT "${constraint}"`,
  );
  await whileAbsent?.();
  await client.unsafe(
    `ALTER TABLE public."${table}" ADD CONSTRAINT "${constraint}" ${value} NOT VALID`,
  );
};

/**
 * Fixture rows skip referential and lifecycle checks through owner-level DDL
 * on the disposable scratch database, never a session role: every foreign key
 * on the seeded tables is dropped and their user triggers pause while the rows
 * are written. A constraint under repair is re-added by `invalidateConstraint`.
 */
const withoutFixtureGuards = async (
  client: SQL,
  tables: readonly string[],
  write: () => Promise<void>,
) => {
  for (const table of tables) {
    const foreignKeys = await client<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = ${`public.${table}`}::regclass AND contype = 'f'`;
    for (const { name } of foreignKeys) {
      await client.unsafe(
        `ALTER TABLE public."${table}" DROP CONSTRAINT "${name}"`,
      );
    }
    await client.unsafe(`ALTER TABLE public."${table}" DISABLE TRIGGER USER`);
  }
  try {
    await write();
  } finally {
    for (const table of tables) {
      await client.unsafe(`ALTER TABLE public."${table}" ENABLE TRIGGER USER`);
    }
  }
};

const noRowSeed = (
  table: string,
  constraint: string,
  insert: string,
): NoRowSeed => ({
  kind: "no-row-work",
  tables: [table],
  snapshot: async (client) => await snapshotRows(client, [table]),
  seed: async (client) => {
    await invalidateConstraint(client, table, constraint, async () => {
      await withoutFixtureGuards(client, [table], async () => {
        await client.unsafe(insert);
      });
    });
  },
});

const withFixtureAuthor = async <T>(
  client: SQL,
  work: (scoped: SQL) => Promise<T>,
) =>
  await client.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE stella");
    await tx.unsafe(
      "SELECT set_config('app.organization_id', 'org', true), set_config('app.user_id', 'user', true)",
    );
    return await work(tx);
  });

const annotationNoRowSeed = (constraint: string): NoRowSeed => ({
  kind: "no-row-work",
  tables: ["legal_reader_annotations"],
  snapshot: async (client) =>
    await withFixtureAuthor(
      client,
      async (scoped) =>
        await snapshotRows(scoped, ["legal_reader_annotations"]),
    ),
  seed: async (client) => {
    await exec(client, [
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', now())",
      `INSERT INTO "user" (id, name, email) VALUES ('user', 'User', 'user@example.invalid')`,
    ]);
    await invalidateConstraint(
      client,
      "legal_reader_annotations",
      constraint,
      async () => {
        await withFixtureAuthor(client, async (scoped) => {
          await scoped.unsafe(READER_ANNOTATION_INSERT);
        });
      },
    );
  },
});

const skillBindingNoRowSeed = (constraint: string): NoRowSeed => ({
  kind: "no-row-work",
  tables: ["agent_skills"],
  snapshot: async (client) =>
    await withFixtureAuthor(
      client,
      async (scoped) => await snapshotRows(scoped, ["agent_skills"]),
    ),
  seed: async (client) => {
    await exec(client, [
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', now())",
      `INSERT INTO "user" (id, name, email) VALUES ('user', 'User', 'user@example.invalid')`,
    ]);
    await invalidateConstraint(client, "agent_skills", constraint, async () => {
      await withFixtureAuthor(client, async (scoped) => {
        await scoped.unsafe(
          `INSERT INTO agent_skills (id, organization_id, user_id, scope, origin, slug, name, description, content_hash, body) VALUES ('${ID}', 'org', 'user', 'private', 'authored', 'fixture', 'Fixture', 'Fixture', repeat('a', 64), 'Fixture')`,
        );
      });
    });
  },
});

const SEEDS = {
  "chat-content-v3": {
    kind: "row-work",
    assertPending: async (client, id) => {
      const rows = await client<{ version: number }[]>`
        SELECT (content->>'version')::integer AS version
        FROM chat_messages WHERE id = ${id}`;
      expect(rows.at(0)?.version, "chat-content-v3").toBe(1);
    },
    assertRepaired: async (client, id) => {
      const rows = await client<{ version: number }[]>`
        SELECT (content->>'version')::integer AS version
        FROM chat_messages WHERE id = ${id}`;
      expect(rows.at(0)?.version, "chat-content-v3").toBe(3);
    },
    seed: async (client) => {
      await invalidateConstraint(
        client,
        "chat_messages",
        "chat_messages_content_v3_check",
        async () => {
          await exec(client, [
            `INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', now())`,
            `INSERT INTO "user" (id, name, email) VALUES ('user', 'User', 'user@example.invalid')`,
            `INSERT INTO chat_threads (id, user_id, title, organization_id) VALUES ('${ID}', 'user', 'Thread', 'org')`,
            `INSERT INTO chat_messages (id, thread_id, user_id, role, content) VALUES ('${ID_2}', '${ID}', 'user', 'user', '{"version":1,"data":[{"type":"text","text":"old"}]}'::jsonb)`,
            `INSERT INTO chat_messages (id, thread_id, user_id, role, content) VALUES ('${ID_3}', '${ID}', 'user', 'user', '{"version":3,"data":[{"type":"text","text":"repaired"}]}'::jsonb)`,
          ]);
        },
      );
    },
    writerLock: { id: ID_2, table: "chat_messages" },
  },
  "decision-date-ceiling": {
    kind: "row-work",
    assertPending: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT decision_date IS NULL AS repaired
        FROM case_law_decisions WHERE id = ${id}`;
      expect(rows.at(0)?.repaired, "decision-date-ceiling").toBeFalse();
    },
    assertRepaired: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT decision_date IS NULL AS repaired
        FROM case_law_decisions WHERE id = ${id}`;
      expect(rows.at(0)?.repaired, "decision-date-ceiling").toBeTrue();
    },
    seed: async (client) => {
      await invalidateConstraint(
        client,
        "case_law_decisions",
        "case_law_decisions_decision_date_bounds",
        async () => {
          await exec(client, [
            `INSERT INTO case_law_sources (id, adapter_key, name) VALUES ('${ID}', 'cz-regional', 'Source')`,
            `INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language, decision_date) VALUES ('${ID_2}', '${ID}', '1', 'Court', 'CZE', 'cs', '9999-01-01')`,
            `INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language, decision_date) VALUES ('${ID_3}', '${ID}', '2', 'Court', 'CZE', 'cs', '9999-01-01')`,
          ]);
        },
      );
    },
    writerLock: { id: ID_2, table: "case_law_decisions" },
  },
  "corpus-projection-delete-receipt": {
    kind: "row-work",
    assertPending: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT delete_task_created_at IS NOT NULL AS repaired
        FROM corpus_index_projection_intents WHERE id = ${id}`;
      expect(
        rows.at(0)?.repaired,
        "corpus-projection-delete-receipt",
      ).toBeFalse();
    },
    assertRepaired: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT delete_task_created_at = updated_at AS repaired
        FROM corpus_index_projection_intents WHERE id = ${id}`;
      expect(
        rows.at(0)?.repaired,
        "corpus-projection-delete-receipt",
      ).toBeTrue();
    },
    seed: async (client) => {
      await invalidateConstraint(
        client,
        "corpus_index_projection_intents",
        "corpus_index_projection_intents_delete_receipt_paired",
        async () => {
          await withoutFixtureGuards(
            client,
            ["corpus_index_generations", "corpus_index_projection_intents"],
            async () => {
              await client.unsafe(
                "INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status) VALUES ('case_law', 'case_law_v1', 'q09', repeat('c', 64), 'serving')",
              );
              await client.unsafe(
                `INSERT INTO corpus_index_projection_intents (id, family, generation, entity_id, epoch, fingerprint, index_id, status, append_started_at, append_publish_barrier_at, cleanup_not_before, cleanup_started_at, delete_opstamp) VALUES ('${ID}', 'case_law', 'case_law_v1', '${ID_2}', 1, repeat('a', 64), 'i', 'cleanup_committed', now(), now(), now(), now(), 1)`,
              );
              await client.unsafe(
                `INSERT INTO corpus_index_projection_intents (id, family, generation, entity_id, epoch, fingerprint, index_id, status, append_started_at, append_publish_barrier_at, cleanup_not_before, cleanup_started_at, delete_opstamp) VALUES ('${ID_3}', 'case_law', 'case_law_v1', '${ID_2}', 2, repeat('b', 64), 'i2', 'cleanup_committed', now(), now(), now(), now(), 1)`,
              );
            },
          );
        },
      );
    },
    writerLock: { id: ID, table: "corpus_index_projection_intents" },
  },
  "entity-feature-row-gates": {
    kind: "row-work",
    assertPending: async (client, id) => {
      const rows = await client<{ gate: string }[]>`
        SELECT entity_feature_gate AS gate FROM entities WHERE id = ${id}`;
      expect(rows.at(0)?.gate, "entity-feature-row-gates").toBe("pending");
    },
    assertRepaired: async (client, id) => {
      const rows = await client<{ gate: string }[]>`
        SELECT entity_feature_gate AS gate FROM entities WHERE id = ${id}`;
      expect(rows.at(0)?.gate, "entity-feature-row-gates").toBe("open");
    },
    seed: async (client) => {
      await invalidateConstraint(
        client,
        "entities",
        "entity_feature_gate_ready_check",
        async () => {
          await withoutFixtureGuards(client, ["entities"], async () => {
            await client.unsafe(
              `INSERT INTO entities (id, workspace_id, name, entity_feature_gate) VALUES ('${ID}', '${ID_2}', 'Writer entity', 'pending'), ('${ID_3}', '${ID_2}', 'Repair entity', 'pending')`,
            );
          });
        },
      );
      await client.unsafe('DROP POLICY "workspace_entity_feature" ON entities');
    },
    writerLock: { id: ID, table: "entities" },
  },
  "better-auth-oauth-resources": {
    kind: "row-work",
    assertPending: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT cardinality(allowed_scopes) > 0 AS repaired
        FROM oauth_resource WHERE id = ${id}`;
      expect(rows.at(0)?.repaired, "better-auth-oauth-resources").toBeFalse();
    },
    assertRepaired: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT cardinality(allowed_scopes) > 0 AS repaired
        FROM oauth_resource WHERE id = ${id}`;
      expect(rows.at(0)?.repaired, "better-auth-oauth-resources").toBeTrue();
    },
    seed: async (client) => {
      const resource = buildBetterAuthOAuthResources("https://test.invalid").at(
        0,
      );
      if (resource === undefined) {
        panic("Expected an OAuth resource");
      }
      await client.unsafe(
        "INSERT INTO oauth_resource (id, identifier, name, allowed_scopes) VALUES ($1, $2, $3, ARRAY[]::text[])",
        [ID, resource.identifier, resource.name],
      );
    },
    writerLock: { id: ID, table: "oauth_resource" },
  },
  sanctions_contact_marks_attempt_count_check: noRowSeed(
    "sanctions_contact_marks",
    "sanctions_contact_marks_attempt_count_check",
    `INSERT INTO sanctions_contact_marks (organization_id, contact_id) VALUES ('org', '${ID}')`,
  ),
  contacts_sanctions_monitoring_mode_check: noRowSeed(
    "contacts",
    "contacts_sanctions_monitoring_mode_check",
    `INSERT INTO contacts (id, organization_id, type, display_name) VALUES ('${ID}', 'org', 'person', 'Contact')`,
  ),
  organization_settings_sanctions_monitoring_mode_check: noRowSeed(
    "organization_settings",
    "organization_settings_sanctions_monitoring_mode_check",
    `INSERT INTO organization_settings (id, organization_id) VALUES ('${ID}', 'org')`,
  ),
  sanctions_contact_matches_disposition_check: noRowSeed(
    "sanctions_contact_matches",
    "sanctions_contact_matches_disposition_check",
    `INSERT INTO sanctions_contact_matches (organization_id, contact_id, source_id, source_entry_id, edition_id, state, disposition, contact_fingerprint, entry_hash, match, updated_at) VALUES ('org', '${ID}', 'source', 'entry', '${ID_2}', 'active', 'needs-review', 'contact', 'entry', '{}', now())`,
  ),
  sanctions_screening_events_type_check: noRowSeed(
    "sanctions_screening_events",
    "sanctions_screening_events_type_check",
    `INSERT INTO sanctions_screening_events (id, organization_id, contact_id, source_id, source_entry_id, type, new_edition_id, reason, created_at) VALUES ('${ID}', 'org', '${ID_2}', 'source', 'entry', 'new', '${ID_3}', 'fixture', now())`,
  ),
  sanctions_contact_screenings_status_check: noRowSeed(
    "sanctions_contact_screenings",
    "sanctions_contact_screenings_status_check",
    `INSERT INTO sanctions_contact_screenings (organization_id, contact_id, source_id, edition_id, status, contact_fingerprint, checked_at) VALUES ('org', '${ID}', 'source', '${ID_2}', 'clear', 'contact', now())`,
  ),
  sanctions_contact_screenings_incomplete_edition_check: noRowSeed(
    "sanctions_contact_screenings",
    "sanctions_contact_screenings_incomplete_edition_check",
    `INSERT INTO sanctions_contact_screenings (organization_id, contact_id, source_id, edition_id, status, contact_fingerprint, checked_at) VALUES ('org', '${ID}', 'source', '${ID_2}', 'incomplete', 'contact', now())`,
  ),
  legal_list_verification_runs_error_code_check: noRowSeed(
    "legal_list_verification_runs",
    "legal_list_verification_runs_error_code_check",
    `INSERT INTO legal_list_verification_runs (id, organization_id, workspace_id, entity_id, file_field_id, entity_version_id, content_sha256, evidence, entity_feature_gate) VALUES ('${ID}', 'org', '${ID_2}', '${ID_3}', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', repeat('a', 64), '{"facts":[],"listId":"fixture"}', 'open')`,
  ),
  legal_reader_annotations_target_type_values: annotationNoRowSeed(
    "legal_reader_annotations_target_type_values",
  ),
  legal_reader_annotations_verification_claim_shape: annotationNoRowSeed(
    "legal_reader_annotations_verification_claim_shape",
  ),
  legal_reader_annotations_workspace_organization_fk: annotationNoRowSeed(
    "legal_reader_annotations_workspace_organization_fk",
  ),
  invoices_language_check: noRowSeed(
    "invoices",
    "invoices_language_check",
    `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status) VALUES ('${ID}', 'org', '${ID_2}', 'INV-1', '2026-09-30', 'EUR', 'draft')`,
  ),
  contacts_invoice_language_check: noRowSeed(
    "contacts",
    "contacts_invoice_language_check",
    `INSERT INTO contacts (id, organization_id, type, display_name) VALUES ('${ID}', 'org', 'person', 'Contact')`,
  ),
  organization_settings_invoice_language_check: noRowSeed(
    "organization_settings",
    "organization_settings_invoice_language_check",
    `INSERT INTO organization_settings (id, organization_id) VALUES ('${ID}', 'org')`,
  ),
  organization_access_states_origin_domain: noRowSeed(
    "organization_access_states",
    "organization_access_states_origin_domain",
    `INSERT INTO organization_access_states (organization_id, state, origin) VALUES ('${ID}', 'self_managed_keys', 'creation')`,
  ),
  "contact-vat-id": {
    kind: "row-work",
    assertPending: async (client, id) => {
      const rows = await client<{ pending: boolean }[]>`
        SELECT vat_id IS NULL AND tax_id = ${VAT_ID} AS pending
        FROM contacts WHERE id = ${id}`;
      expect(rows.at(0)?.pending, "contact-vat-id").toBeTrue();
    },
    assertRepaired: async (client, id) => {
      const rows = await client<{ repaired: boolean }[]>`
        SELECT vat_id = ${VAT_ID} AND tax_id IS NULL AS repaired
        FROM contacts WHERE id = ${id}`;
      expect(rows.at(0)?.repaired, "contact-vat-id").toBeTrue();
    },
    seed: async (client) => {
      await client.unsafe(
        "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', now())",
      );
      await client.unsafe(
        `INSERT INTO contacts (id, organization_id, type, display_name, tax_id) VALUES ('${ID_2}', 'org', 'organization', 'Writer contact', '${VAT_ID}'), ('${ID_3}', 'org', 'organization', 'Repair contact', '${VAT_ID}')`,
      );
    },
    writerLock: { id: ID_2, table: "contacts" },
  },
  case_law_decisions_parsed_source_complete: {
    kind: "no-row-work",
    tables: ["case_law_decisions"],
    snapshot: async (client) =>
      await snapshotRows(client, ["case_law_decisions"]),
    seed: async (client) => {
      await client.unsafe(
        `INSERT INTO case_law_sources (id, adapter_key, name) VALUES ('${ID}', 'cz-regional', 'Source')`,
      );
      await invalidateConstraint(
        client,
        "case_law_decisions",
        "case_law_decisions_parsed_source_complete",
        async () => {
          await client.unsafe(
            `INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language) VALUES ('${ID_2}', '${ID}', '1', 'Court', 'CZE', 'cs')`,
          );
        },
      );
    },
  },
  agent_skills_single_binding_check: skillBindingNoRowSeed(
    "agent_skills_single_binding_check",
  ),
  agent_skills_bound_workspace_fk: skillBindingNoRowSeed(
    "agent_skills_bound_workspace_fk",
  ),
  agent_skills_bound_client_fk: skillBindingNoRowSeed(
    "agent_skills_bound_client_fk",
  ),
  "corpus-projection-cleanup-stall": {
    kind: "no-row-work",
    tables: ["corpus_index_projection_intents"],
    snapshot: async (client) =>
      await snapshotRows(client, ["corpus_index_projection_intents"]),
    seed: async (client) => {
      for (const constraint of [
        "corpus_index_projection_intents_status_values",
        "corpus_index_projection_intents_status_shape",
        "corpus_index_projection_intents_delete_reissues_nonnegative",
      ]) {
        await invalidateConstraint(
          client,
          "corpus_index_projection_intents",
          constraint,
        );
      }
      await withoutFixtureGuards(
        client,
        ["corpus_index_projection_intents"],
        async () => {
          await client.unsafe(
            `INSERT INTO corpus_index_projection_intents (id, family, generation, entity_id, epoch, fingerprint, index_id, status, append_started_at, append_publish_barrier_at, cleanup_not_before, cleanup_started_at, delete_opstamp, delete_task_created_at, updated_at) VALUES ('${ID}', 'case_law', 'case_law_v1', '${ID_2}', 1, repeat('a', 64), 'i', 'cleanup_committed', now(), now(), now(), now(), 1, now(), now())`,
          );
        },
      );
    },
  },
} as const satisfies Record<RepairName, Seed>;
const seedsByName: Readonly<Record<string, Seed>> = SEEDS;

const adapter = (connection: ReservedSQL): OnlineMigrationConnection => ({
  query: async (statement, parameters = []) =>
    await connection.unsafe<unknown[]>(statement, [...parameters]),
  execute: async (statement, parameters = []) => {
    await connection.unsafe(statement, [...parameters]);
  },
  release: async () => connection.release(),
  terminate: async () => await terminateReserved(connection),
});

const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

type ScratchClientScope = Parameters<
  Parameters<typeof withGatedTestClients>[1]
>[0];

const withScratch = async (
  name: string,
  work: (scope: ScratchClientScope) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  if (templateDatabase === undefined) {
    panic("STELLA_TEST_TEMPLATE_DATABASE required");
  }
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  await withGatedTestClients(
    maintenanceUrl.toString(),
    async ({ openClient }) => {
      const admin = openClient().sql;
      const prefix = "online_rows_";
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      // PostgreSQL truncates identifiers; retain the entire unique suffix.
      const labelBudget =
        POSTGRES_IDENTIFIER_MAX_BYTES - prefix.length - suffix.length - 1;
      const label = name.replaceAll(/[^a-z0-9]/gu, "_").slice(0, labelBudget);
      const database = `${prefix}${label}_${suffix}`;
      await admin.unsafe(
        `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(templateDatabase)}`,
      );
      const url = new URL(databaseUrl);
      url.pathname = `/${database}`;
      try {
        await withGatedTestClients(url.toString(), work, {
          closeMode: "force",
        });
      } finally {
        await admin.unsafe(`DROP DATABASE ${quoteIdentifier(database)}`);
      }
    },
  );
};

const assertRegistryAndSeedsMatch = () => {
  expect(Object.keys(SEEDS).toSorted()).toEqual(
    ONLINE_MIGRATION_REPAIRS.map(({ name }) => name).toSorted(),
  );
};

const snapshotRows = async (client: SQL, tables: readonly string[]) => {
  const snapshot: Record<string, string[]> = {};
  for (const table of tables) {
    const rows = await client.unsafe<{ xmin: string }[]>(
      `SELECT xmin::text AS xmin FROM public."${table}" ORDER BY ctid`,
    );
    snapshot[table] = rows.map(({ xmin }) => xmin);
  }
  return snapshot;
};

type ContendingWriterOptions<T> = {
  connection: SQL;
  updates: Parameters<typeof contendSession>[0]["updates"];
  work: () => Promise<{ startMs: number; value: T }>;
};

const withContendingWriter = async <T>({
  connection,
  updates,
  work,
}: ContendingWriterOptions<T>) => {
  const events: WriterEvent[] = [];
  const abort = new AbortController();
  let committed!: () => void;
  const firstCommit = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const writerRun = Result.tryPromise(
    async () =>
      await contendSession({
        connection,
        updates,
        holdMs: WRITER_HOLD_MS,
        onHeld: null,
        onEvent: (kind, at) => {
          events.push({ kind, at, session: 0 });
          if (kind === "commit") {
            committed();
          }
        },
        signal: abort.signal,
      }),
  );
  let writerOutcome!: Awaited<typeof writerRun>;
  let endMs = 0;
  const workOutcome = await Result.tryPromise(async () => {
    try {
      const ready = await Promise.race([
        firstCommit.then(() => ({ type: "commit" }) as const),
        writerRun.then((result) => ({ type: "writer", result }) as const),
      ]);
      if (ready.type === "writer") {
        if (ready.result.isErr()) {
          throw ready.result.error;
        }
        panic("Contending writer stopped before its first commit");
      }
      return await work();
    } finally {
      abort.abort();
      writerOutcome = await writerRun;
      endMs = Date.now();
    }
  });
  if (workOutcome.isErr() && writerOutcome.isErr()) {
    if (workOutcome.error === writerOutcome.error) {
      throw writerOutcome.error;
    }
    throw new AggregateError(
      [workOutcome.error, writerOutcome.error],
      "Repair work and contending writer both failed",
    );
  }
  if (workOutcome.isErr()) {
    throw workOutcome.error;
  }
  if (writerOutcome.isErr()) {
    throw writerOutcome.error;
  }
  return { ...workOutcome.value, endMs, events };
};

type TimedRepairOptions = {
  connection: OnlineMigrationConnection;
  repair: OnlineRepair;
  session: ReservedSQL;
};

const runTimedRepair = async ({
  connection,
  repair,
  session,
}: TimedRepairOptions) => {
  const result = await Result.tryPromise(
    async () =>
      await withTimeout(
        async () =>
          await repair.repair(
            connection,
            createUngatedTableGateForTests(connection),
          ),
        { timeoutMs: DEADLINE_MS, label: `Online repair ${repair.name}` },
      ),
  );
  if (result.isOk()) {
    return result.value;
  }
  if (result.error instanceof TimeoutError) {
    // The deadline does not cancel SQL; release its locks before draining the writer.
    const terminated = await Result.tryPromise(
      async () => await terminateReserved(session),
    );
    if (terminated.isErr()) {
      throw new AggregateError(
        [result.error, terminated.error],
        `Online repair ${repair.name} timed out and its session could not be terminated`,
      );
    }
  }
  throw result.error;
};

const exercise = async (repair: (typeof ONLINE_MIGRATION_REPAIRS)[number]) => {
  const seed = seedsByName[repair.name];
  if (seed === undefined) {
    panic(`Online repair ${repair.name} has no writer seed`);
  }
  if (seed.kind === "no-row-work") {
    await withScratch(repair.name, async ({ openClient }) => {
      const owner = openClient().sql;
      await seed.seed(owner);
      const before = await seed.snapshot(owner);
      for (const table of seed.tables) {
        expect(before[table]?.length, `${repair.name}: ${table} seed`).toBe(1);
      }
      const repairClient = openClient().sql;
      const repairSession = await repairClient.reserve();
      try {
        const connection = adapter(repairSession);
        expect(
          (await repair.readCompletion(connection)).type,
          repair.name,
        ).not.toBe("complete");
        const outcome = await runTimedRepair({
          connection,
          repair,
          session: repairSession,
        });
        expect(outcome.type, repair.name).toBe("complete");
        expect(await seed.snapshot(owner), repair.name).toEqual(before);
      } finally {
        await repairSession.release();
      }
    });
    console.log(
      JSON.stringify({
        repair: repair.name,
        maxGapMs: 0,
        commits: 0,
        refusals: 0,
      }),
    );
    return;
  }
  await withScratch(repair.name, async ({ openClient }) => {
    const owner = openClient().sql;
    await seed.seed(owner);
    await owner.unsafe(
      "CREATE TABLE repair_writer_heartbeat (id integer PRIMARY KEY, touched_at timestamptz)",
    );
    await owner.unsafe("INSERT INTO repair_writer_heartbeat (id) VALUES (1)");
    const writerUpdate = {
      parameters: [seed.writerLock.id],
      statement: `WITH held AS MATERIALIZED (SELECT 1 FROM public."${seed.writerLock.table}" WHERE id = $1 FOR UPDATE), changed AS (UPDATE repair_writer_heartbeat SET touched_at = clock_timestamp() WHERE id = 1 AND EXISTS (SELECT FROM held) RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
    };
    const repairClient = openClient().sql;
    const repairSession = await repairClient.reserve();
    try {
      const connection = adapter(repairSession);
      expect(
        (await repair.readCompletion(connection)).type,
        repair.name,
      ).not.toBe("complete");
      const {
        startMs,
        endMs,
        events,
        value: outcome,
      } = await withContendingWriter({
        // Bound writer lock waits even if terminating the repair fails.
        connection: openClient({
          connection: { lock_timeout: DEADLINE_MS },
        }).sql,
        updates: [writerUpdate],
        work: async () => {
          await seed.assertPending(owner, seed.writerLock.id);
          const workStartedAt = Date.now();
          const repaired = await runTimedRepair({
            connection,
            repair,
            session: repairSession,
          });
          return { startMs: workStartedAt, value: repaired };
        },
      });
      expect(outcome.type, repair.name).toBe("complete");
      const report = writerGapReport({
        events,
        window: { startMs, endMs },
        sessions: 1,
      });
      const verdict = judgeWriterGap(report, GAP_BUDGET_SECONDS);
      console.log(
        JSON.stringify({
          repair: repair.name,
          maxGapMs: report.maxGapMs,
          commits: report.commits,
          refusals: report.refusals,
        }),
      );
      expect(verdict.kind, `${repair.name}: ${verdict.summary}`).toBe("within");
      expect(report.refusals, repair.name).toBe(0);
      expect((await repair.readCompletion(connection)).type, repair.name).toBe(
        "complete",
      );
      await seed.assertRepaired(owner, seed.writerLock.id);
    } finally {
      await repairSession.release();
    }
  });
};

describe.skipIf(!enabled)("online repairs run beside writers", () => {
  test(
    "the seed map exactly enumerates the repair registry",
    assertRegistryAndSeedsMatch,
  );
  for (const repair of ONLINE_MIGRATION_REPAIRS) {
    test(`${repair.name} keeps its writer moving`, async () =>
      await exercise(repair));
  }

  test("the writer-gap judge rejects a repair holding its row for 2.5 s", async () => {
    await withScratch("self_test", async ({ openClient }) => {
      const owner = openClient().sql;
      await owner.unsafe(
        "CREATE TABLE fixture_repair (id integer PRIMARY KEY, touched_at timestamptz)",
      );
      await owner.unsafe("INSERT INTO fixture_repair (id) VALUES (1)");
      const repairClient = openClient().sql;
      const repair = await repairClient.reserve();
      try {
        const { startMs, endMs, events } = await withContendingWriter({
          // Bound writer lock waits even if terminating the repair fails.
          connection: openClient({
            connection: { lock_timeout: DEADLINE_MS },
          }).sql,
          updates: [
            "WITH changed AS (UPDATE fixture_repair SET touched_at = clock_timestamp() WHERE id = 1 RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed",
          ],
          work: async () => {
            const holdStartedAt = Date.now();
            await repair.begin(async (tx) => {
              await tx.unsafe(
                "UPDATE fixture_repair SET touched_at = clock_timestamp() WHERE id = 1",
              );
              // real-time: Deliberately hold the PostgreSQL row beyond the 2 s writer-gap budget so the negative oracle must fail.
              await Bun.sleep(2500);
            });
            return { startMs: holdStartedAt, value: undefined };
          },
        });
        const report = writerGapReport({
          events,
          window: { startMs, endMs },
          sessions: 1,
        });
        expect(judgeWriterGap(report, GAP_BUDGET_SECONDS).kind).toBe("over");
      } finally {
        await repair.release();
      }
    });
  });
});
