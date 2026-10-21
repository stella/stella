import { panic } from "better-result";
import type { ReservedSQL, SQL } from "bun";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import nodePath from "node:path";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { buildBetterAuthOAuthResources } from "@/api/mcp/resource-policy-contract";

import { contendSession } from "../../../../scripts/migration-rehearsal-contender";
import type { WriterEvent } from "../../../../scripts/migration-rehearsal-writer-gap";
import {
  judgeWriterGap,
  writerGapReport,
} from "../../../../scripts/migration-rehearsal-writer-gap";
import { withGatedTestClients } from "../tests/gated-test-database";
import { runMigrations } from "./migration-runner";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";
import { terminateReserved } from "./sql-close";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const DEADLINE_MS = 30_000;
const GAP_BUDGET_SECONDS = 2;
const WRITER_HOLD_MS = 10;
const ID = "00000000-0000-4000-8000-000000000001";
const ID_2 = "00000000-0000-4000-8000-000000000002";
const ID_3 = "00000000-0000-4000-8000-000000000003";
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
const templateDatabase = `online_rows_template_${Bun.randomUUIDv7().replaceAll("-", "")}`;

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

const noRowSeed = (
  table: string,
  constraint: string,
  insert: string,
): NoRowSeed => ({
  kind: "no-row-work",
  tables: [table],
  seed: async (client) => {
    await invalidateConstraint(client, table, constraint, async () => {
      await client.unsafe("SET session_replication_role = replica");
      await client.unsafe(insert);
      await client.unsafe("SET session_replication_role = origin");
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
          await client.unsafe("SET session_replication_role = replica");
          await client.unsafe(
            "INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status) VALUES ('case_law', 'case_law_v1', 'q09', repeat('c', 64), 'serving')",
          );
          await client.unsafe(
            `INSERT INTO corpus_index_projection_intents (id, family, generation, entity_id, epoch, fingerprint, index_id, status, append_started_at, append_publish_barrier_at, cleanup_not_before, cleanup_started_at, delete_opstamp) VALUES ('${ID}', 'case_law', 'case_law_v1', '${ID_2}', 1, repeat('a', 64), 'i', 'cleanup_committed', now(), now(), now(), now(), 1)`,
          );
          await client.unsafe(
            `INSERT INTO corpus_index_projection_intents (id, family, generation, entity_id, epoch, fingerprint, index_id, status, append_started_at, append_publish_barrier_at, cleanup_not_before, cleanup_started_at, delete_opstamp) VALUES ('${ID_3}', 'case_law', 'case_law_v1', '${ID_2}', 2, repeat('b', 64), 'i2', 'cleanup_committed', now(), now(), now(), now(), 1)`,
          );
          await client.unsafe("SET session_replication_role = origin");
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
          await client.unsafe("SET session_replication_role = replica");
          await client.unsafe(
            `INSERT INTO entities (id, workspace_id, name, entity_feature_gate) VALUES ('${ID}', '${ID_2}', 'Writer entity', 'pending'), ('${ID_3}', '${ID_2}', 'Repair entity', 'pending')`,
          );
          await client.unsafe("SET session_replication_role = origin");
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
  "corpus-projection-cleanup-stall": {
    kind: "no-row-work",
    tables: ["corpus_index_projection_intents"],
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
      await client.unsafe("SET session_replication_role = replica");
      await client.unsafe(
        `INSERT INTO corpus_index_projection_intents (id, family, generation, entity_id, epoch, fingerprint, index_id, status, append_started_at, append_publish_barrier_at, cleanup_not_before, cleanup_started_at, delete_opstamp, delete_task_created_at, updated_at) VALUES ('${ID}', 'case_law', 'case_law_v1', '${ID_2}', 1, repeat('a', 64), 'i', 'cleanup_committed', now(), now(), now(), now(), 1, now(), now())`,
      );
      await client.unsafe("SET session_replication_role = origin");
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
  release: () => connection.release(),
  terminate: async () => await terminateReserved(connection),
});

const withScratch = async (
  name: string,
  work: (openClient: () => SQL) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const admin = openClient().sql;
    const database = `online_rows_${name.replaceAll(/[^a-z0-9]/gu, "_")}_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await admin.unsafe(
      `CREATE DATABASE "${database}" TEMPLATE "${templateDatabase}"`,
    );
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    try {
      await withGatedTestClients(
        url.toString(),
        async ({ openClient: open }) => {
          await work(() => open().sql);
        },
        { closeMode: "force" },
      );
    } finally {
      await admin.unsafe(`DROP DATABASE "${database}"`);
    }
  });
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

const exercise = async (repair: (typeof ONLINE_MIGRATION_REPAIRS)[number]) => {
  const seed = seedsByName[repair.name];
  if (seed === undefined) {
    panic(`Online repair ${repair.name} has no writer seed`);
  }
  if (seed.kind === "no-row-work") {
    await withScratch(repair.name, async (openClient) => {
      const owner = openClient();
      await seed.seed(owner);
      const before = await snapshotRows(owner, seed.tables);
      for (const table of seed.tables) {
        expect(before[table]?.length, `${repair.name}: ${table} seed`).toBe(1);
      }
      const repairClient = openClient();
      const repairSession = await repairClient.reserve();
      const connection = adapter(repairSession);
      expect(
        (await repair.readCompletion(connection)).type,
        repair.name,
      ).not.toBe("complete");
      const outcome = await withTimeout(
        async () =>
          await repair.repair(
            connection,
            createUngatedTableGateForTests(connection),
          ),
        { timeoutMs: DEADLINE_MS, label: `Online repair ${repair.name}` },
      );
      expect(outcome.type, repair.name).toBe("complete");
      expect(await snapshotRows(owner, seed.tables), repair.name).toEqual(
        before,
      );
      repairSession.release();
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
  await withScratch(repair.name, async (openClient) => {
    const owner = openClient();
    await seed.seed(owner);
    await owner.unsafe(
      "CREATE TABLE repair_writer_heartbeat (id integer PRIMARY KEY, touched_at timestamptz)",
    );
    await owner.unsafe("INSERT INTO repair_writer_heartbeat (id) VALUES (1)");
    const writerUpdate = {
      parameters: [seed.writerLock.id],
      statement: `WITH held AS MATERIALIZED (SELECT 1 FROM public."${seed.writerLock.table}" WHERE id = $1 FOR UPDATE), changed AS (UPDATE repair_writer_heartbeat SET touched_at = clock_timestamp() WHERE id = 1 AND EXISTS (SELECT FROM held) RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
    };
    const repairClient = openClient();
    const repairSession = await repairClient.reserve();
    const writerClient = openClient();
    const writer = writerClient;
    const connection = adapter(repairSession);
    expect(
      (await repair.readCompletion(connection)).type,
      repair.name,
    ).not.toBe("complete");

    const events: WriterEvent[] = [];
    const abort = new AbortController();
    let held!: () => void;
    const firstCommit = new Promise<void>((resolve) => {
      held = resolve;
    });
    const writerRun = contendSession({
      connection: writer,
      updates: [writerUpdate],
      holdMs: WRITER_HOLD_MS,
      onHeld: held,
      onEvent: (kind, at) => {
        events.push({ kind, at, session: 0 });
      },
      signal: abort.signal,
    });
    await firstCommit;
    while (!events.some(({ kind }) => kind === "commit")) {
      await Bun.sleep(1);
    }
    await seed.assertPending(owner, seed.writerLock.id);
    const startMs = Date.now();
    const outcome = await withTimeout(
      async () =>
        await repair.repair(
          connection,
          createUngatedTableGateForTests(connection),
        ),
      {
        timeoutMs: DEADLINE_MS,
        label: `Online repair ${repair.name}`,
      },
    );
    expect(outcome.type, repair.name).toBe("complete");
    abort.abort();
    await writerRun;
    const endMs = Date.now();
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
    repairSession.release();
  });
};

describe.skipIf(!enabled)("online repairs run beside writers", () => {
  beforeAll(async () => {
    const url = databaseUrl ?? panic("DATABASE_URL required");
    const sourceDatabase = decodeURIComponent(
      new URL(url).pathname.slice(1),
    ).replaceAll('"', '""');
    const adminUrl = new URL(url);
    adminUrl.pathname = "/postgres";
    await withGatedTestClients(adminUrl.toString(), async ({ openClient }) => {
      const admin = openClient().sql;
      await admin`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${decodeURIComponent(new URL(url).pathname.slice(1))}
          AND pid <> pg_backend_pid()
      `;
      await admin.unsafe(
        `CREATE DATABASE "${templateDatabase}" TEMPLATE "${sourceDatabase}"`,
      );
    });
    const templateUrl = new URL(url);
    templateUrl.pathname = `/${templateDatabase}`;
    await withGatedTestClients(
      templateUrl.toString(),
      async ({ openClient }) => {
        const connection = await openClient({ max: 1 }).sql.reserve();
        try {
          await runMigrations({
            connection,
            migrationsFolder,
            databaseUrl: templateUrl.toString(),
            ebs: { type: "disabled" },
          });
          await connection.unsafe(`
            DO $$
            DECLARE tables text;
            BEGIN
              SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
                INTO tables
                FROM pg_tables
                WHERE schemaname = 'public';
              IF tables IS NOT NULL THEN
                EXECUTE 'TRUNCATE TABLE ' || tables || ' CASCADE';
              END IF;
            END $$
          `);
        } finally {
          connection.release();
        }
      },
      { closeMode: "force" },
    );
  });

  afterAll(async () => {
    const url = databaseUrl ?? panic("DATABASE_URL required");
    await withGatedTestClients(url, async ({ openClient }) => {
      await openClient().sql.unsafe(
        `DROP DATABASE IF EXISTS "${templateDatabase}"`,
      );
    });
  });

  test(
    "the seed map exactly enumerates the repair registry",
    assertRegistryAndSeedsMatch,
  );
  for (const repair of ONLINE_MIGRATION_REPAIRS) {
    test(`${repair.name} keeps its writer moving`, async () =>
      await exercise(repair));
  }

  test("the writer-gap judge rejects a repair holding its row for 2.5 s", async () => {
    await withScratch("self_test", async (openClient) => {
      const owner = openClient();
      await owner.unsafe(
        "CREATE TABLE fixture_repair (id integer PRIMARY KEY, touched_at timestamptz)",
      );
      await owner.unsafe("INSERT INTO fixture_repair (id) VALUES (1)");
      const repairClient = openClient();
      const repair = await repairClient.reserve();
      const writer = openClient();
      const events: WriterEvent[] = [];
      const abort = new AbortController();
      let held!: () => void;
      const ready = new Promise<void>((resolve) => {
        held = resolve;
      });
      const writerRun = contendSession({
        connection: writer,
        updates: [
          "WITH changed AS (UPDATE fixture_repair SET touched_at = clock_timestamp() WHERE id = 1 RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed",
        ],
        holdMs: WRITER_HOLD_MS,
        onHeld: held,
        onEvent: (kind, at) => {
          events.push({ kind, at, session: 0 });
        },
        signal: abort.signal,
      });
      await ready;
      while (!events.some(({ kind }) => kind === "commit")) {
        await Bun.sleep(1);
      }
      const startMs = Date.now();
      await repair.unsafe("BEGIN");
      await repair.unsafe(
        "UPDATE fixture_repair SET touched_at = clock_timestamp() WHERE id = 1",
      );
      await Bun.sleep(2500);
      await repair.unsafe("COMMIT");
      abort.abort();
      await writerRun;
      const report = writerGapReport({
        events,
        window: { startMs, endMs: Date.now() },
        sessions: 1,
      });
      expect(judgeWriterGap(report, GAP_BUDGET_SECONDS).kind).toBe("over");
      repair.release();
    });
  });
});
