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
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000010";
const CONTACT_ID = "00000000-0000-4000-8000-000000000011";
const ENTITY_ID = "00000000-0000-4000-8000-000000000012";
const FIXTURE_ORGANIZATION =
  "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', now())";
const FIXTURE_USER = `INSERT INTO "user" (id, name, email) VALUES ('user', 'User', 'user@example.invalid')`;
const FIXTURE_WORKSPACE = `INSERT INTO workspaces (id, organization_id, name, reference) VALUES ('${WORKSPACE_ID}', 'org', 'Matter', 'M-1')`;
const FIXTURE_MEMBER = `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('member', 'org', 'user', 'owner', now())`;
const FIXTURE_CONTACT = `INSERT INTO contacts (id, organization_id, type, display_name) VALUES ('${CONTACT_ID}', 'org', 'organization', 'Client')`;
/** A draft invoice on the fixture matter. */
const FIXTURE_INVOICE = `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', 'INV-1', '2026-09-30', 'EUR', 'draft')`;
const TIME_ENTRY_INSERT = `INSERT INTO time_entries (id, organization_id, workspace_id, date_worked, timezone_id, duration_minutes, billed_minutes, rate_at_entry, currency, narrative) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', '2026-09-30', 'Europe/Prague', 60, 60, 100, 'EUR', 'Work')`;
const EXPENSE_INSERT = `INSERT INTO expenses (id, organization_id, workspace_id, matter_id, date_incurred, amount, currency, category, description) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', '${ID_2}', '2026-09-30', 100, 'EUR', 'other', 'Expense')`;
const INVOICE_LINE_INSERT = `INSERT INTO invoice_lines (id, organization_id, workspace_id, invoice_id, position, description, quantity, unit_price, vat_rate_bps, vat_treatment, net_amount, vat_amount, gross_amount, source) VALUES ('${ID_2}', 'org', '${WORKSPACE_ID}', '${ID}', 0, 'Line', 1, 100, 0, 'exempt', 100, 0, 100, 'manual')`;
/** Columns every delivered email row shares. */
const EMAIL_COLUMNS = `id, organization_id, workspace_id, direction, channel, intake, authenticated_sender_address, content_hash, dedup_key, sender, recipients_to, recipients_cc, subject, received_at, "references", body_text, spf, dkim, dmarc, entity_feature_gate`;
const EMAIL_VALUES = `'${ID}', 'org', '${WORKSPACE_ID}', 'in', 'email', 'direct', 'sender@example.invalid', repeat('a', 64), repeat('b', 64), '{}', '[]', '[]', 'Subject', now(), '[]', 'Body', 'pass', 'pass', 'pass', 'open'`;
const CORRESPONDENCE_EMAIL = `INSERT INTO correspondence (${EMAIL_COLUMNS}) VALUES (${EMAIL_VALUES})`;
/** An uploaded data-box message; its source entity is the fixture entity. */
const CORRESPONDENCE_DATA_BOX = `INSERT INTO correspondence (id, organization_id, workspace_id, channel, source, source_entity_id, message_id, original_signature, data_box_envelope, content_hash, dedup_key, sender, recipients_to, recipients_cc, subject, received_at, "references", body_text, entity_feature_gate) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', 'data_box', 'upload', '${ENTITY_ID}', 'message', '{"status":"unverified"}', '{"messageId":"message"}', repeat('a', 64), repeat('b', 64), '{}', '[]', '[]', 'Subject', now(), '[]', 'Body', 'open')`;
const EXTERNAL_REF_COLUMNS =
  "external_source, external_id, external_change_key, imported_at";
const EXTERNAL_REF_VALUES = "'fixture', 'external-1', 'change-1', now()";
const SITEMAP_ENROLLMENT = "case-law-sitemap-packing-enrollment";
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
  /**
   * The row the contending writer holds. `column` names a key other than `id`;
   * `organizationId` scopes a table forcing row security on its owner.
   */
  writerLock: {
    column?: string;
    id: string;
    organizationId?: string;
    table: string;
  };
};
type NoRowSeed = {
  kind: "no-row-work";
  /** Rows the seed leaves in each table; one when absent. */
  rows?: number;
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

const withFixtureAuthor = async <T>(
  client: SQL,
  work: (scoped: SQL) => Promise<T>,
) =>
  await client.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE stella");
    await tx.unsafe(
      `SELECT set_config('app.organization_id', 'org', true), set_config('app.user_id', 'user', true), set_config('app.workspace_ids', '{${WORKSPACE_ID}}', true), set_config('app.workspace_access_mode', 'membership', true)`,
    );
    return await work(tx);
  });

type NoRowOptions = {
  /** Parents the validated foreign key must find, written before its rows. */
  parents?: (client: SQL) => Promise<void>;
  /** Rows the insert writes, when it writes more than one. */
  rows?: number;
  /** The table forces row security on its owner: use the application role. */
  scoped?: boolean;
};

const noRowSeed = (
  table: string,
  constraint: string,
  insert: string,
  { parents, rows, scoped = false }: NoRowOptions = {},
): NoRowSeed => {
  const inScope = async <T>(client: SQL, work: (reader: SQL) => Promise<T>) =>
    scoped ? await withFixtureAuthor(client, work) : await work(client);
  return {
    kind: "no-row-work",
    ...(rows === undefined ? {} : { rows }),
    tables: [table],
    snapshot: async (client) =>
      await inScope(client, async (reader) => snapshotRows(reader, [table])),
    seed: async (client) => {
      await parents?.(client);
      await invalidateConstraint(client, table, constraint, async () => {
        await withoutFixtureGuards(client, [table], async () => {
          await inScope(client, async (writer) => {
            await writer.unsafe(insert);
          });
        });
      });
    },
  };
};

const contactNoRowSeed = (constraint: string, insert?: string) =>
  noRowSeed(
    "contacts",
    constraint,
    insert ??
      `INSERT INTO contacts (id, organization_id, type, display_name) VALUES ('${ID}', 'org', 'person', 'Contact')`,
    { scoped: true },
  );

const withMatter = async (client: SQL) => {
  await exec(client, [FIXTURE_ORGANIZATION, FIXTURE_WORKSPACE]);
};

const withClient = async (client: SQL) => {
  await exec(client, [FIXTURE_ORGANIZATION]);
  await withFixtureAuthor(client, async (scoped) => {
    await scoped.unsafe(FIXTURE_CONTACT);
  });
};

/** An invoice the fixture author may reach: invoice lines' row policy reads it. */
const withInvoice = async (client: SQL) => {
  await exec(client, [
    FIXTURE_ORGANIZATION,
    FIXTURE_USER,
    FIXTURE_MEMBER,
    FIXTURE_WORKSPACE,
    FIXTURE_INVOICE,
  ]);
};

const withFixtureEntity = async (client: SQL) => {
  await withoutFixtureGuards(client, ["entities"], async () => {
    await client.unsafe(
      `INSERT INTO entities (id, workspace_id, name, entity_feature_gate) VALUES ('${ENTITY_ID}', '${WORKSPACE_ID}', 'Source', 'open')`,
    );
  });
};

const invoiceFkSeed = (constraint: string) =>
  noRowSeed("invoices", constraint, FIXTURE_INVOICE, { parents: withMatter });

const invoiceLineSeed = (constraint: string, insert = INVOICE_LINE_INSERT) =>
  noRowSeed("invoice_lines", constraint, insert, {
    parents: withInvoice,
    scoped: true,
  });

const timeEntryFkSeed = (constraint: string) =>
  noRowSeed("time_entries", constraint, TIME_ENTRY_INSERT, {
    parents: withMatter,
  });

const expenseFkSeed = (constraint: string) =>
  noRowSeed("expenses", constraint, EXPENSE_INSERT, { parents: withMatter });

const withLinkParents = async (client: SQL) => {
  await exec(client, [FIXTURE_ORGANIZATION, FIXTURE_USER, FIXTURE_WORKSPACE]);
  await withoutFixtureGuards(client, ["legislation_documents"], async () => {
    await client.unsafe(
      `INSERT INTO legislation_documents (id, source_id, eli, title, country, language) VALUES ('${ID_2}', '${ID_3}', 'eli/fixture', 'Statute', 'CZE', 'cs')`,
    );
  });
};

const legislationLinkSeed = (constraint: string) =>
  noRowSeed(
    "legislation_matter_links",
    constraint,
    `INSERT INTO legislation_matter_links (id, document_id, statute_id, provision_id, applied_version, jurisdiction, workspace_id, linked_by) VALUES ('${ID}', '${ID_2}', 'statute', 'provision', '2026-09-30', 'CZE', '${WORKSPACE_ID}', 'user')`,
    { parents: withLinkParents },
  );

const correspondenceSeed = (constraint: string, insert: string) =>
  noRowSeed("correspondence", constraint, insert, { scoped: true });

const billingArrangementSeed = (constraint: string, insert: string) =>
  noRowSeed("billing_arrangements", constraint, insert, { scoped: true });

/** The row a repair owes, read by one predicate before and after it runs. */
const repairedWhen = (name: string, query: string, scoped = false) => {
  const read = async (client: SQL, id: string) => {
    const run = async (reader: SQL) =>
      await reader.unsafe<{ repaired: boolean }[]>(query, [id]);
    const rows = scoped
      ? await withFixtureAuthor(client, run)
      : await run(client);
    return rows.at(0)?.repaired;
  };
  return {
    assertPending: async (client: SQL, id: string) => {
      expect(await read(client, id), `${name} pending`).toBeFalse();
    },
    assertRepaired: async (client: SQL, id: string) => {
      expect(await read(client, id), name).toBeTrue();
    },
  };
};

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
  contacts_sanctions_monitoring_mode_check: contactNoRowSeed(
    "contacts_sanctions_monitoring_mode_check",
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
  contacts_invoice_language_check: contactNoRowSeed(
    "contacts_invoice_language_check",
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
    ...repairedWhen(
      "contact-vat-id",
      `SELECT vat_id IS NOT DISTINCT FROM '${VAT_ID}' AND tax_id IS NULL AS repaired FROM contacts WHERE id = $1`,
      true,
    ),
    seed: async (client) => {
      await client.unsafe(FIXTURE_ORGANIZATION);
      await invalidateConstraint(
        client,
        "contacts",
        "contacts_vat_id_check",
        async () => {
          await withFixtureAuthor(client, async (scoped) => {
            await scoped.unsafe(
              `INSERT INTO contacts (id, organization_id, type, display_name, tax_id) VALUES ('${ID_2}', 'org', 'organization', 'Writer contact', '${VAT_ID}'), ('${ID_3}', 'org', 'organization', 'Repair contact', '${VAT_ID}')`,
            );
          });
        },
      );
    },
    writerLock: { id: ID_2, organizationId: "org", table: "contacts" },
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
  "chat-run-text-boundaries": {
    kind: "row-work",
    ...repairedWhen(
      "chat-run-text-boundaries",
      "SELECT text_boundary_initialization IS NOT DISTINCT FROM 'recorded' AND text_message_end_seq IS NOT DISTINCT FROM 2 AS repaired FROM chat_run_log_entries WHERE run_id = $1 AND seq = 1",
    ),
    seed: async (client) => {
      await withoutFixtureGuards(client, ["chat_run_log_entries"], async () => {
        await client.unsafe(
          `INSERT INTO chat_run_log_entries (organization_id, run_id, seq, batch_id, batch_index, chunk) SELECT 'org', run_id, seq, '${ID}', seq, jsonb_build_object('type', type, 'messageId', 'message') FROM (VALUES ('run-writer'), ('run-repair')) AS runs(run_id) CROSS JOIN (VALUES (1, 'TEXT_MESSAGE_START'), (2, 'TEXT_MESSAGE_END')) AS events(seq, type)`,
        );
      });
    },
    writerLock: {
      column: "run_id",
      id: "run-writer",
      table: "chat_run_log_entries",
    },
  },
  account_audit_logs_event_type_check: noRowSeed(
    "account_audit_logs",
    "account_audit_logs_event_type_check",
    `INSERT INTO account_audit_logs (id, user_id, event_type, resource_id, group_id) VALUES ('${ID}', 'user', 'organization.created', 'org', '${ID_2}')`,
    { scoped: true },
  ),
  "client-invoice-tenant-key": {
    kind: "no-row-work",
    tables: ["invoices"],
    snapshot: async (client) => await snapshotRows(client, ["invoices"]),
    seed: async (client) => {
      await withInvoice(client);
      await exec(client, [
        `ALTER TABLE public.invoices DROP CONSTRAINT invoices_original_organization_fk`,
        `ALTER TABLE public.invoices DROP CONSTRAINT invoices_id_org_unique`,
        `CREATE UNIQUE INDEX invoices_id_org_unique ON public.invoices USING btree (id, organization_id)`,
      ]);
    },
  },
  "client-invoice-clients": {
    kind: "row-work",
    ...repairedWhen(
      "client-invoice-clients",
      `SELECT client_id IS NOT DISTINCT FROM '${CONTACT_ID}' AS repaired FROM invoices WHERE id = $1`,
    ),
    seed: async (client) => {
      await withClient(client);
      // The matter gains its client after the invoices: the legacy shape, past every guard.
      await exec(client, [
        FIXTURE_WORKSPACE,
        FIXTURE_INVOICE,
        `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status) VALUES ('${ID_2}', 'org', '${WORKSPACE_ID}', 'INV-2', '2026-09-30', 'EUR', 'draft')`,
        `UPDATE workspaces SET client_id = '${CONTACT_ID}' WHERE id = '${WORKSPACE_ID}'`,
      ]);
    },
    writerLock: { id: ID, table: "invoices" },
  },
  invoices_workspace_id_workspaces_id_fkey: invoiceFkSeed(
    "invoices_workspace_id_workspaces_id_fkey",
  ),
  invoices_workspace_organization_fk: invoiceFkSeed(
    "invoices_workspace_organization_fk",
  ),
  invoice_lines_workspace_id_workspaces_id_fk: invoiceLineSeed(
    "invoice_lines_workspace_id_workspaces_id_fk",
  ),
  invoice_lines_workspace_organization_fk: invoiceLineSeed(
    "invoice_lines_workspace_organization_fk",
  ),
  invoices_scope_check: noRowSeed(
    "invoices",
    "invoices_scope_check",
    `INSERT INTO invoices (id, organization_id, client_id, invoice_number, invoice_date, currency, status) VALUES ('${ID}', 'org', '${CONTACT_ID}', 'INV-1', '2026-09-30', 'EUR', 'draft')`,
    { parents: withClient },
  ),
  invoices_original_organization_fk: noRowSeed(
    "invoices",
    "invoices_original_organization_fk",
    `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status, document_type, original_invoice_id) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', 'INV-1', '2026-09-30', 'EUR', 'draft', 'invoice', NULL), ('${ID_2}', 'org', '${WORKSPACE_ID}', 'CN-1', '2026-09-30', 'EUR', 'draft', 'credit_note', '${ID}')`,
    { rows: 2 },
  ),
  invoice_lines_recorded_snapshot_check: invoiceLineSeed(
    "invoice_lines_recorded_snapshot_check",
    `INSERT INTO invoice_lines (id, organization_id, workspace_id, invoice_id, position, description, quantity, unit_price, vat_rate_bps, vat_treatment, net_amount, vat_amount, gross_amount, source, recorded_description, recorded_quantity, recorded_unit_price, recorded_net_amount) VALUES ('${ID_2}', 'org', '${WORKSPACE_ID}', '${ID}', 0, 'Line', 1, 100, 0, 'exempt', 100, 0, 100, 'manual', 'Recorded', 1, 100, 100)`,
  ),
  time_entries_workspace_id_workspaces_id_fkey: timeEntryFkSeed(
    "time_entries_workspace_id_workspaces_id_fkey",
  ),
  time_entries_workspace_organization_fk: timeEntryFkSeed(
    "time_entries_workspace_organization_fk",
  ),
  expenses_workspace_id_workspaces_id_fkey: expenseFkSeed(
    "expenses_workspace_id_workspaces_id_fkey",
  ),
  expenses_workspace_organization_fk: expenseFkSeed(
    "expenses_workspace_organization_fk",
  ),
  case_law_identifier_retry_shape: noRowSeed(
    "case_law_decision_identifier_backfills",
    "case_law_identifier_retry_shape",
    "INSERT INTO case_law_decision_identifier_backfills (version, verification_retry_count, verification_retry_after) VALUES ('fixture', 3, now())",
  ),
  organization_settings_ai_billing_drafts_mode_check: noRowSeed(
    "organization_settings",
    "organization_settings_ai_billing_drafts_mode_check",
    `INSERT INTO organization_settings (id, organization_id, ai_billing_drafts_mode) VALUES ('${ID}', 'org', 'enabled')`,
  ),
  contacts_time_billing_format_check: contactNoRowSeed(
    "contacts_time_billing_format_check",
    `INSERT INTO contacts (id, organization_id, type, display_name, time_billing_format) VALUES ('${ID}', 'org', 'person', 'Contact', 'ledes')`,
  ),
  organization_access_states_shape: noRowSeed(
    "organization_access_states",
    "organization_access_states_shape",
    `INSERT INTO organization_access_states (organization_id, state, origin, evaluation_started_at, evaluation_ends_at) VALUES ('${ID}', 'evaluation_period', 'creation', now(), now() + interval '1 day')`,
  ),
  legal_reader_annotations_matter_document_shape: annotationNoRowSeed(
    "legal_reader_annotations_matter_document_shape",
  ),
  legal_reader_answer_messages_error_code_values: noRowSeed(
    "legal_reader_answer_messages",
    "legal_reader_answer_messages_error_code_values",
    `INSERT INTO legal_reader_answer_messages (id, answer_id, role, content, status, sequence, error_code) VALUES ('${ID_2}', '${ID}', 'assistant', 'Answer', 'failed', 1, 'internal')`,
    {
      // The message's row policy reads its answer.
      parents: async (client) => {
        await exec(client, [FIXTURE_ORGANIZATION, FIXTURE_USER]);
        await withoutFixtureGuards(
          client,
          ["legal_reader_answers"],
          async () => {
            await withFixtureAuthor(client, async (scoped) => {
              await scoped.unsafe(
                `INSERT INTO legal_reader_answers (id, organization_id, user_id, decision_id, kind, paragraph_id, quote, start_offset, end_offset) VALUES ('${ID}', 'org', 'user', '${ID_3}', 'ask', 'p-1', 'words', 0, 5)`,
              );
            });
          },
        );
      },
      scoped: true,
    },
  ),
  legislation_matter_links_document_fk: legislationLinkSeed(
    "legislation_matter_links_document_fk",
  ),
  legislation_matter_links_workspace_id_workspaces_id_fkey: legislationLinkSeed(
    "legislation_matter_links_workspace_id_workspaces_id_fkey",
  ),
  legislation_matter_links_linked_by_user_id_fkey: legislationLinkSeed(
    "legislation_matter_links_linked_by_user_id_fkey",
  ),
  rate_entries_activity_code_id_billing_codes_id_fk: noRowSeed(
    "rate_entries",
    "rate_entries_activity_code_id_billing_codes_id_fk",
    `INSERT INTO rate_entries (id, workspace_id, rate_table_id, hourly_rate, effective_from, activity_code_id) VALUES ('${ID}', '${WORKSPACE_ID}', '${ID_2}', 100, '2026-09-30', '${ID_3}')`,
    {
      parents: async (client) => {
        await withoutFixtureGuards(client, ["billing_codes"], async () => {
          await client.unsafe(
            `INSERT INTO billing_codes (id, organization_id, workspace_id, type, code, label) VALUES ('${ID_3}', 'org', '${WORKSPACE_ID}', 'activity', 'A101', 'Activity')`,
          );
        });
      },
    },
  ),
  billing_arrangements_mode_caps_check: billingArrangementSeed(
    "billing_arrangements_mode_caps_check",
    `INSERT INTO billing_arrangements (workspace_id, organization_id, mode, currency, flat_fee_amount) VALUES ('${WORKSPACE_ID}', 'org', 'flat_fee', 'EUR', 100)`,
  ),
  billing_arrangements_minute_crossing_check: billingArrangementSeed(
    "billing_arrangements_minute_crossing_check",
    `INSERT INTO billing_arrangements (workspace_id, organization_id, mode, currency, minute_threshold_state, minute_cap_state) VALUES ('${WORKSPACE_ID}', 'org', 'hourly', 'EUR', 'below', 'above')`,
  ),
  user_email_undeliverable_check: noRowSeed(
    "user",
    "user_email_undeliverable_check",
    `INSERT INTO "user" (id, name, email, email_undeliverable_address, email_undeliverable_reason, email_undeliverable_at) VALUES ('user', 'User', 'user@example.invalid', 'user@example.invalid', 'hard_bounce', now())`,
  ),
  time_entries_internal_shape_check: noRowSeed(
    "time_entries",
    "time_entries_internal_shape_check",
    `INSERT INTO time_entries (id, organization_id, activity_group, date_worked, timezone_id, duration_minutes, billed_minutes, rate_at_entry, currency, narrative, billable, no_charge, status) VALUES ('${ID}', 'org', 'internal', '2026-09-30', 'Europe/Prague', 60, 0, 0, 'XXX', 'Internal work', false, false, 'draft')`,
  ),
  usage_events_action_type_domain: noRowSeed(
    "usage_events",
    "usage_events_action_type_domain",
    `INSERT INTO usage_events (id, organization_id, user_id, period_start, period_end, action_type, model_role, units_consumed, service_tier) VALUES ('${ID}', 'org', 'user', '2026-09-01', '2026-10-01', 'chat', 'chat', 1, 'standard')`,
  ),
  notifications_kind_check: noRowSeed(
    "notifications",
    "notifications_kind_check",
    `INSERT INTO notifications (id, user_id, organization_id, kind, metadata, idempotency_key) VALUES ('${ID}', 'user', 'org', 'announcement', '{}', 'fixture')`,
  ),
  notifications_entity_type_check: noRowSeed(
    "notifications",
    "notifications_entity_type_check",
    `INSERT INTO notifications (id, user_id, organization_id, kind, metadata, idempotency_key, entity_type, entity_id) VALUES ('${ID}', 'user', 'org', 'task_assigned', '{}', 'fixture', 'task', '${ID_2}')`,
  ),
  "invoice-sent-at": {
    kind: "row-work",
    ...repairedWhen(
      "invoice-sent-at",
      "SELECT sent_at IS NOT DISTINCT FROM updated_at AS repaired FROM invoices WHERE id = $1",
    ),
    seed: async (client) => {
      await withMatter(client);
      await client.unsafe(
        `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', 'INV-1', '2026-09-30', 'EUR', 'sent'), ('${ID_2}', 'org', '${WORKSPACE_ID}', 'INV-2', '2026-09-30', 'EUR', 'sent')`,
      );
    },
    writerLock: { id: ID, table: "invoices" },
  },
  "invoice-legacy-payments": {
    kind: "row-work",
    ...repairedWhen(
      "invoice-legacy-payments",
      "SELECT EXISTS (SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = $1 AND payment.origin = 'legacy' AND payment.amount = 12300 AND payment.method = 'other' AND payment.recorded_by IS NULL) AS repaired",
    ),
    seed: async (client) => {
      await withMatter(client);
      await client.unsafe(
        `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status, total_amount, paid_at) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', 'INV-1', '2026-09-30', 'EUR', 'paid', 12300, now()), ('${ID_2}', 'org', '${WORKSPACE_ID}', 'INV-2', '2026-09-30', 'EUR', 'paid', 12300, now())`,
      );
    },
    writerLock: { id: ID, table: "invoices" },
  },
  contacts_external_ref_check: contactNoRowSeed(
    "contacts_external_ref_check",
    `INSERT INTO contacts (id, organization_id, type, display_name, ${EXTERNAL_REF_COLUMNS}) VALUES ('${ID}', 'org', 'person', 'Contact', ${EXTERNAL_REF_VALUES})`,
  ),
  workspaces_external_ref_check: noRowSeed(
    "workspaces",
    "workspaces_external_ref_check",
    `INSERT INTO workspaces (id, organization_id, name, reference, ${EXTERNAL_REF_COLUMNS}) VALUES ('${WORKSPACE_ID}', 'org', 'Matter', 'M-1', ${EXTERNAL_REF_VALUES})`,
  ),
  time_entries_external_ref_check: noRowSeed(
    "time_entries",
    "time_entries_external_ref_check",
    `INSERT INTO time_entries (id, organization_id, workspace_id, date_worked, timezone_id, duration_minutes, billed_minutes, rate_at_entry, currency, narrative, ${EXTERNAL_REF_COLUMNS}) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', '2026-09-30', 'Europe/Prague', 60, 60, 100, 'EUR', 'Work', ${EXTERNAL_REF_VALUES})`,
  ),
  expenses_external_ref_check: noRowSeed(
    "expenses",
    "expenses_external_ref_check",
    `INSERT INTO expenses (id, organization_id, workspace_id, matter_id, date_incurred, amount, currency, category, description, ${EXTERNAL_REF_COLUMNS}) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', '${ID_2}', '2026-09-30', 100, 'EUR', 'other', 'Expense', ${EXTERNAL_REF_VALUES})`,
  ),
  invoices_external_ref_check: noRowSeed(
    "invoices",
    "invoices_external_ref_check",
    `INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status, ${EXTERNAL_REF_COLUMNS}) VALUES ('${ID}', 'org', '${WORKSPACE_ID}', 'INV-1', '2026-09-30', 'EUR', 'draft', ${EXTERNAL_REF_VALUES})`,
  ),
  correspondence_external_ref_check: correspondenceSeed(
    "correspondence_external_ref_check",
    `INSERT INTO correspondence (${EMAIL_COLUMNS}, ${EXTERNAL_REF_COLUMNS}) VALUES (${EMAIL_VALUES}, ${EXTERNAL_REF_VALUES})`,
  ),
  "document-review-finding-decisions": {
    kind: "row-work",
    ...repairedWhen(
      "document-review-finding-decisions",
      "SELECT EXISTS (SELECT 1 FROM document_review_finding_decisions event WHERE event.finding_id = $1 AND event.decision = 'accepted' AND event.actor_id = 'user') AS repaired",
    ),
    seed: async (client) => {
      await exec(client, [
        FIXTURE_ORGANIZATION,
        FIXTURE_USER,
        FIXTURE_WORKSPACE,
      ]);
      await withoutFixtureGuards(
        client,
        ["document_review_findings"],
        async () => {
          await client.unsafe(
            `INSERT INTO document_review_findings (id, organization_id, workspace_id, run_id, entity_id, file_field_id, entity_version_id, position_id, payload, position_title, decision, decided_by, decided_at) SELECT finding_id, 'org', '${WORKSPACE_ID}', '${ID_3}', '${ID_3}', '${ID_3}', '${ID_3}', finding_id, '{}', 'Position', 'accepted', 'user', now() FROM unnest(ARRAY['${ID}', '${ID_2}']::uuid[]) AS finding_id`,
          );
        },
      );
    },
    writerLock: { id: ID, table: "document_review_findings" },
  },
  "legal-list-source-decisions": {
    kind: "row-work",
    ...repairedWhen(
      "legal-list-source-decisions",
      "SELECT EXISTS (SELECT 1 FROM legal_list_item_source_decisions event WHERE event.source_id = $1 AND event.decision = 'accepted' AND event.actor_id = 'user') AS repaired",
    ),
    seed: async (client) => {
      await exec(client, [
        FIXTURE_ORGANIZATION,
        FIXTURE_USER,
        FIXTURE_WORKSPACE,
      ]);
      await withoutFixtureGuards(
        client,
        ["legal_list_item_sources"],
        async () => {
          await client.unsafe(
            `INSERT INTO legal_list_item_sources (id, workspace_id, list_id, item_entity_id, source_entity_id, source_entity_version_id, locator, verification_status, verified_by, verified_at, entity_feature_gate) SELECT source_id, '${WORKSPACE_ID}', '${ID_3}', '${ID_3}', '${ID_3}', '${ID_3}', '{}', 'verified', 'user', now(), 'open' FROM unnest(ARRAY['${ID}', '${ID_2}']::uuid[]) AS source_id`,
          );
        },
      );
    },
    writerLock: { id: ID, table: "legal_list_item_sources" },
  },
  "case-law-sitemap-packing-enrollment": {
    kind: "row-work",
    ...repairedWhen(
      SITEMAP_ENROLLMENT,
      "SELECT cursor IS NOT DISTINCT FROM 'complete' AND EXISTS (SELECT 1 FROM case_law_sitemap_changes WHERE country = 'CZE' AND year = '*' AND month = '*') AS repaired FROM database_backfill_states WHERE name = $1",
    ),
    seed: async (client) => {
      await exec(client, [
        "INSERT INTO case_law_sitemap_shards (country, year, month, bucket, total, last_modified_at) VALUES ('CZE', '2026', '09', '000', 1, now())",
        `UPDATE database_backfill_states SET cursor = NULL WHERE name = '${SITEMAP_ENROLLMENT}'`,
      ]);
    },
    // The repair serializes its batches on this checkpoint.
    writerLock: {
      column: "name",
      id: SITEMAP_ENROLLMENT,
      table: "database_backfill_states",
    },
  },
  "case-law-population-counts": {
    kind: "row-work",
    ...repairedWhen(
      "case-law-population-counts",
      "SELECT EXISTS (SELECT 1 FROM case_law_population_projections projection WHERE projection.decision_id = $1) AS repaired",
    ),
    seed: async (client) => {
      await client.unsafe(
        `INSERT INTO case_law_sources (id, adapter_key, name) VALUES ('${ID_3}', 'cz-regional', 'Source')`,
      );
      await withoutFixtureGuards(client, ["case_law_decisions"], async () => {
        await client.unsafe(
          `INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language) VALUES ('${ID}', '${ID_3}', '1', 'Court', 'CZE', 'cs'), ('${ID_2}', '${ID_3}', '2', 'Court', 'CZE', 'cs')`,
        );
      });
      await client.unsafe(
        "UPDATE case_law_population_seed_state SET phase = 'scan', cursor = NULL, source_id = NULL WHERE slot = 0",
      );
    },
    writerLock: { id: ID, table: "case_law_decisions" },
  },
  case_law_source_string_config: {
    kind: "row-work",
    ...repairedWhen(
      "case_law_source_string_config",
      "SELECT jsonb_typeof(config) = 'object' AS repaired FROM case_law_sources WHERE id = $1",
    ),
    seed: async (client) => {
      await client.unsafe(
        `INSERT INTO case_law_sources (id, adapter_key, name, config) VALUES ('${ID}', 'cz-regional', 'Writer source', '"{}"'::jsonb), ('${ID_2}', 'cz-regional-2', 'Repair source', '"{}"'::jsonb)`,
      );
    },
    writerLock: { id: ID, table: "case_law_sources" },
  },
  correspondence_direction_check: correspondenceSeed(
    "correspondence_direction_check",
    CORRESPONDENCE_EMAIL,
  ),
  correspondence_channel_check: correspondenceSeed(
    "correspondence_channel_check",
    CORRESPONDENCE_EMAIL,
  ),
  correspondence_data_box_check: correspondenceSeed(
    "correspondence_data_box_check",
    CORRESPONDENCE_DATA_BOX,
  ),
  organization_settings_data_box_ids_check: noRowSeed(
    "organization_settings",
    "organization_settings_data_box_ids_check",
    `INSERT INTO organization_settings (id, organization_id, data_box_ids) VALUES ('${ID}', 'org', '["abc1234"]')`,
  ),
  correspondence_source_entity_workspace_fk: noRowSeed(
    "correspondence",
    "correspondence_source_entity_workspace_fk",
    CORRESPONDENCE_DATA_BOX,
    { parents: withFixtureEntity, scoped: true },
  ),
  desktop_runner_commands_kind_check: noRowSeed(
    "desktop_runner_commands",
    "desktop_runner_commands_kind_check",
    `INSERT INTO desktop_runner_commands (run_id, kind, command_key, payload) VALUES ('${ID}', 'run.input', '${ID_2}', '{}')`,
  ),
  desktop_runner_events_request_check: noRowSeed(
    "desktop_runner_events",
    "desktop_runner_events_request_check",
    `INSERT INTO desktop_runner_events (run_id, seq, type, request_id, message) VALUES ('${ID}', 1, 'run.approval_request', '${ID_2}', '{}')`,
  ),
  chat_turns_interaction_values_check: noRowSeed(
    "chat_turns",
    "chat_turns_interaction_values_check",
    `INSERT INTO chat_turns (id, organization_id, user_id, thread_id, user_message_id, status, assistant_message_id, interaction_type, interaction_tool_call_id) VALUES ('${ID}', 'org', 'user', '${ID_2}', '${ID_3}', 'awaiting-user', '${ENTITY_ID}', 'approval', 'call')`,
  ),
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
        expect(before[table]?.length, `${repair.name}: ${table} seed`).toBe(
          seed.rows ?? 1,
        );
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
        expect(
          (await repair.readCompletion(connection)).type,
          repair.name,
        ).toBe("complete");
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
    const { column = "id", organizationId } = seed.writerLock;
    const writerUpdate = {
      parameters: [seed.writerLock.id],
      statement: `WITH held AS MATERIALIZED (SELECT 1 FROM public."${seed.writerLock.table}" WHERE "${column}" = $1 FOR UPDATE), changed AS (UPDATE repair_writer_heartbeat SET touched_at = clock_timestamp() WHERE id = 1 AND EXISTS (SELECT FROM held) RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
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
        updates:
          organizationId === undefined
            ? [writerUpdate]
            : [
                `SELECT set_config('app.organization_id', '${organizationId}', true)`,
                writerUpdate,
              ],
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
