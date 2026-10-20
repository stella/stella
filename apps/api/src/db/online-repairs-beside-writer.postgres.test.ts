import { panic } from "better-result";
import type { ReservedSQL, SQL } from "bun";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { buildBetterAuthOAuthResources } from "@/api/mcp/resource-policy-contract";

import { contendSession } from "../../../../scripts/migration-rehearsal-contender";
import type { WriterEvent } from "../../../../scripts/migration-rehearsal-writer-gap";
import {
  judgeWriterGap,
  writerGapReport,
} from "../../../../scripts/migration-rehearsal-writer-gap";
import { withGatedTestClients } from "../tests/gated-test-database";
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

setDefaultTimeout(120_000);

type RepairName = (typeof ONLINE_MIGRATION_REPAIRS)[number]["name"];
type RowSeed = {
  kind: "row-work";
  seed: (client: SQL) => Promise<void>;
  writerUpdate: string;
};
type Seed = RowSeed | { kind: "no-row-work" };

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

const SEEDS = {
  "chat-content-v3": {
    kind: "row-work",
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
            `INSERT INTO chat_messages (id, thread_id, user_id, role, content) VALUES ('${ID_3}', '${ID}', 'user', 'user', '{"version":1,"data":[{"type":"text","text":"repair"}]}'::jsonb)`,
          ]);
        },
      );
    },
    writerUpdate: `WITH changed AS (UPDATE chat_messages SET content = '{"version":3,"data":[{"type":"text","text":"writer"}]}'::jsonb, created_at = clock_timestamp() WHERE id = '${ID_2}' RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
  },
  "decision-date-ceiling": {
    kind: "row-work",
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
    writerUpdate: `WITH changed AS (UPDATE case_law_decisions SET decision_date = NULL, updated_at = clock_timestamp() WHERE id = '${ID_2}' RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
  },
  "corpus-projection-delete-receipt": {
    kind: "row-work",
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
    writerUpdate: `WITH changed AS (UPDATE corpus_index_projection_intents SET delete_task_created_at = updated_at WHERE id = '${ID}' RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
  },
  "entity-feature-row-gates": {
    kind: "row-work",
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
    writerUpdate: `WITH changed AS (UPDATE entities SET entity_feature_gate = 'ready', updated_at = clock_timestamp() WHERE id = '${ID}' RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
  },
  "better-auth-oauth-resources": {
    kind: "row-work",
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
    writerUpdate: `WITH changed AS (UPDATE oauth_resource SET updated_at = clock_timestamp() WHERE id = '${ID}' RETURNING 1) SELECT 1 / CASE count(*) WHEN 1 THEN 1 ELSE 0 END FROM changed`,
  },
  sanctions_contact_marks_attempt_count_check: { kind: "no-row-work" },
  contacts_sanctions_monitoring_mode_check: { kind: "no-row-work" },
  organization_settings_sanctions_monitoring_mode_check: {
    kind: "no-row-work",
  },
  sanctions_contact_matches_disposition_check: { kind: "no-row-work" },
  sanctions_screening_events_type_check: { kind: "no-row-work" },
  sanctions_contact_screenings_status_check: { kind: "no-row-work" },
  sanctions_contact_screenings_incomplete_edition_check: {
    kind: "no-row-work",
  },
  legal_list_verification_runs_error_code_check: { kind: "no-row-work" },
  "corpus-projection-cleanup-stall": { kind: "no-row-work" },
} as const satisfies Record<RepairName, Seed>;

const adapter = (connection: ReservedSQL): OnlineMigrationConnection => ({
  query: async (statement, parameters = []) =>
    await connection.unsafe<unknown[]>(statement, [...parameters]),
  execute: async (statement, parameters = []) => {
    await connection.unsafe(statement, [...parameters]);
  },
  release: () => connection.release(),
  terminate: async () => await terminateReserved(connection),
});

const runProcess = async (
  command: string,
  args: string[],
  input?: Uint8Array,
) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => {
      resolve(value ?? 1);
    });
  });
  if (code !== 0) {
    panic(`${command} failed: ${Buffer.concat(stderr).toString()}`);
  }
  return Buffer.concat(stdout);
};

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
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    try {
      const schema = await runProcess("pg_dump", [
        "--schema-only",
        databaseUrl,
      ]);
      await runProcess(
        "psql",
        ["--set", "ON_ERROR_STOP=1", url.toString()],
        schema,
      );
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

const exercise = async (repair: (typeof ONLINE_MIGRATION_REPAIRS)[number]) => {
  const seed = SEEDS[repair.name];
  if (seed === undefined) {
    panic(`Online repair ${repair.name} has no writer seed`);
  }
  if (seed.kind === "no-row-work") {
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
      updates: [seed.writerUpdate],
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
    repairSession.release();
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
