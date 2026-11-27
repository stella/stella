/**
 * `wake-deferred` against a real PostgreSQL schema: it wakes exactly the
 * states the append walk would take but for a settlement bound an earlier
 * release queued them at, in batches, prints the same count and ids digest
 * before and after, reruns as a no-op, and refuses a generation whose hits
 * do not carry their revision. Rows a writer holds are passed over; that
 * takes a second connection and runs against PostgreSQL in
 * `corpus-index-projection-append-behind-cleanup.postgres.test.ts`.
 */
import { panic, Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  type CaseLawRootHandle,
  readOnlyHandles,
} from "@/api/lib/case-law/maintenance-lane";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  runCorpusGenerationCommand,
  type WithCorpusDatabase,
} from "@/api/scripts/corpus-generation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/** v10's hits carry their revision; v7's do not. */
const STORED = "case_law_v10";
const QUERY_ONLY = "case_law_v7";
const indexOf = (generation: string) => `${generation}_pol`;

/** More owed states than one batch of the command takes. */
const DEFERRED_ROWS = 507;

/** Entity ids by role; each role has its own block of the id space. */
const ROLE = {
  deferred: 0,
  noRevision: 1,
  deleting: 2,
  appendInFlight: 3,
  stalled: 4,
  backoff: 5,
  runnable: 6,
  converged: 7,
  queryOnly: 8,
  twoDeleting: 9,
  namedLive: 10,
} as const;
type Role = keyof typeof ROLE;

const entity = (role: Role, n: number) =>
  `0198e331-e578-7000-8${String(ROLE[role]).padStart(2, "0")}0-${String(n).padStart(12, "0")}`;
const revision = (role: Role, n: number) =>
  `0198e331-e578-7000-9${String(ROLE[role]).padStart(2, "0")}0-${String(n).padStart(12, "0")}`;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const rootHandle = (): CaseLawRootHandle =>
  asTestRaw<CaseLawRootHandle>({
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
      await db.transaction(async (tx) => await fn(asTestRaw<Transaction>(tx))),
    execute: async (query: Parameters<typeof db.execute>[0]) =>
      await db.execute(query),
  });

/** Reports read through the production read-only wrapper; writes do not. */
const testDatabase: WithCorpusDatabase = async (access, work) => {
  switch (access) {
    case "read":
      return Result.ok(
        await work(
          readOnlyHandles({
            rootDb: rootHandle(),
            ingestionDb: async () =>
              panic("the command uses no ingestion handle"),
          }).rootDb,
        ),
      );
    case "write":
      return Result.ok(await work(rootHandle()));
    default:
      access satisfies never;
      return panic("unhandled access");
  }
};

const wake = async (args: readonly string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCorpusGenerationCommand({
    args: ["wake-deferred", "--family", "case_law", ...args],
    withDatabase: testDatabase,
    write: (line) => {
      out.push(line);
    },
    writeError: (line) => {
      err.push(line);
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const run = async (query: string, params: unknown[] = []) => {
  await client.query(query, params);
};

const register = async (generation: "case_law_v7" | "case_law_v10") =>
  await run(
    `INSERT INTO corpus_index_generations
       (family, generation, cluster, manifest_digest, status)
     VALUES ('case_law', $1, 'q09', $2, 'building')`,
    [generation, corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS[generation])],
  );

/**
 * A state that needs an upsert appended, queued at `queuedAt` (SQL, relative
 * to the database clock) with an optional failure backoff.
 */
const insertState = async ({
  generation,
  role,
  n,
  queuedAt,
  retryNotBefore = "NULL",
  workStatus = "eligible",
}: {
  generation: string;
  role: Role;
  n: number;
  queuedAt: string;
  retryNotBefore?: string;
  workStatus?: string;
}) =>
  await run(
    `INSERT INTO corpus_index_projection_states
       (family, generation, entity_id, desired_action, desired_epoch,
        desired_fingerprint, desired_index_id, work_status, retry_not_before,
        last_failure_kind, last_failure_message, created_at, updated_at)
     VALUES ('case_law', $1, $2, 'upsert', 2, lpad('2', 64, '0'), $3, $4,
       ${retryNotBefore}, $5, $6, '2026-08-01', ${queuedAt})`,
    [
      generation,
      entity(role, n),
      indexOf(generation),
      workStatus,
      workStatus === "retry_scheduled" ? "append_transient" : null,
      workStatus === "retry_scheduled" ? "engine was busy" : null,
    ],
  );

/** Columns each status's shape check requires, for a revision at epoch 1. */
const SHAPE: Record<string, string> = {
  append_started: `append_started_at = '2026-08-01'`,
  cleanup_pending: `append_started_at = '2026-08-01',
    append_publish_barrier_at = '2026-08-01',
    cleanup_not_before = '2026-08-01'`,
  cleanup_committed: `append_started_at = '2026-08-01',
    append_publish_barrier_at = '2026-08-01',
    cleanup_not_before = '2026-08-01', cleanup_started_at = '2026-08-01',
    delete_opstamp = 7, delete_task_created_at = '2026-08-01'`,
  cleanup_stalled: `append_started_at = '2026-08-01',
    append_publish_barrier_at = '2026-08-01',
    cleanup_not_before = '2026-08-01', cleanup_started_at = '2026-08-01',
    delete_opstamp = 7, delete_task_created_at = '2026-08-01'`,
  settled: `append_started_at = '2026-08-01',
    append_publish_barrier_at = '2026-08-01',
    cleanup_not_before = '2026-08-01', cleanup_started_at = '2026-08-01',
    delete_opstamp = 7, delete_task_created_at = '2026-08-01',
    settled_at = '2026-08-02'`,
  applied: `append_started_at = '2026-08-01',
    append_committed_at = '2026-08-01', append_publish_barrier_at = '2026-08-01',
    applied_at = '2026-08-01', expected_document_count = 1`,
};

/**
 * One revision of the entity in `status`. Inserted reserved, as the insert
 * guard requires, then given its status's shape in one update; this suite
 * installs no transition guard, so the fixture states history directly.
 */
const insertRevision = async ({
  generation,
  role,
  n,
  status,
  id = revision(role, n),
  epoch = 1,
}: {
  generation: string;
  role: Role;
  n: number;
  status: keyof typeof SHAPE;
  id?: string;
  epoch?: number;
}) => {
  await run(
    `INSERT INTO corpus_index_projection_intents
       (id, family, generation, entity_id, epoch, fingerprint, index_id,
        status, append_delivery, lease_token, lease_expires_at, created_at,
        updated_at)
     VALUES ($1, 'case_law', $2, $3, $4::bigint, lpad($4::bigint::text, 64, '0'), $5,
       'reserved', 'ingest_api', gen_random_uuid(), '2026-08-02',
       '2026-08-01', '2026-08-01')`,
    [id, generation, entity(role, n), epoch, indexOf(generation)],
  );
  await run(
    `UPDATE corpus_index_projection_intents
     SET status = $2,
       ${status === "append_started" ? "" : "lease_token = NULL, lease_expires_at = NULL,"}
       ${SHAPE[status] ?? panic(`No shape for ${status}`)}
     WHERE id = $1`,
    [id, status],
  );
};

const FUTURE = "now() + interval '7 days'";
const PAST = "now() - interval '1 hour'";

const seed = async () => {
  await register(STORED);
  await register(QUERY_ONLY);
  // Woken: deferred with only a delete in flight, or with nothing at all.
  for (let n = 1; n <= DEFERRED_ROWS; n += 1) {
    // db-await-in-loop: fixture rows, in order
    await insertState({
      generation: STORED,
      role: "deferred",
      n,
      queuedAt: FUTURE,
    });
    // db-await-in-loop: fixture rows, in order
    await insertRevision({
      generation: STORED,
      role: "deferred",
      n,
      status: n % 2 === 0 ? "cleanup_committed" : "cleanup_pending",
    });
  }
  await insertState({
    generation: STORED,
    role: "noRevision",
    n: 1,
    queuedAt: FUTURE,
  });
  // Woken: a settled revision and a delete in flight are both passable.
  await insertState({
    generation: STORED,
    role: "deleting",
    n: 1,
    queuedAt: FUTURE,
  });
  await insertRevision({
    generation: STORED,
    role: "deleting",
    n: 1,
    status: "settled",
  });
  await insertRevision({
    generation: STORED,
    role: "deleting",
    n: 1,
    status: "cleanup_committed",
    id: revision("deleting", 2),
  });
  // Untouched: an append in flight or a stall still holds the append.
  await insertState({
    generation: STORED,
    role: "appendInFlight",
    n: 1,
    queuedAt: FUTURE,
  });
  await insertRevision({
    generation: STORED,
    role: "appendInFlight",
    n: 1,
    status: "cleanup_committed",
  });
  await insertRevision({
    generation: STORED,
    role: "appendInFlight",
    n: 1,
    status: "append_started",
    id: revision("appendInFlight", 2),
    epoch: 2,
  });
  await insertState({
    generation: STORED,
    role: "stalled",
    n: 1,
    queuedAt: FUTURE,
  });
  await insertRevision({
    generation: STORED,
    role: "stalled",
    n: 1,
    status: "cleanup_stalled",
  });
  // Untouched: a failure backoff is its own instant.
  await insertState({
    generation: STORED,
    role: "backoff",
    n: 1,
    queuedAt: FUTURE,
    retryNotBefore: FUTURE,
    workStatus: "retry_scheduled",
  });
  await insertRevision({
    generation: STORED,
    role: "backoff",
    n: 1,
    status: "cleanup_committed",
  });
  // Untouched: already runnable.
  await insertState({
    generation: STORED,
    role: "runnable",
    n: 1,
    queuedAt: PAST,
  });
  await insertRevision({
    generation: STORED,
    role: "runnable",
    n: 1,
    status: "cleanup_committed",
  });
  // Untouched: converged, so not work at all.
  await insertRevision({
    generation: STORED,
    role: "converged",
    n: 1,
    status: "applied",
  });
  await run(
    `INSERT INTO corpus_index_projection_states
       (family, generation, entity_id, desired_action, desired_epoch,
        desired_fingerprint, desired_index_id, work_status, applied_action,
        applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
        applied_at, created_at, updated_at)
     VALUES ('case_law', $1, $2, 'upsert', 1, lpad('1', 64, '0'), $3,
       'eligible', 'upsert', 1, $4, lpad('1', 64, '0'), $3, '2026-08-01',
       '2026-08-01', ${FUTURE})`,
    [STORED, entity("converged", 1), indexOf(STORED), revision("converged", 1)],
  );
  // Untouched: two revisions being deleted at once hold the append.
  await insertState({
    generation: STORED,
    role: "twoDeleting",
    n: 1,
    queuedAt: FUTURE,
  });
  await insertRevision({
    generation: STORED,
    role: "twoDeleting",
    n: 1,
    status: "cleanup_committed",
  });
  await insertRevision({
    generation: STORED,
    role: "twoDeleting",
    n: 1,
    status: "cleanup_pending",
    id: revision("twoDeleting", 2),
  });
  // Untouched: a state that still names a live copy waits for it.
  await insertRevision({
    generation: STORED,
    role: "namedLive",
    n: 1,
    status: "applied",
  });
  await run(
    `INSERT INTO corpus_index_projection_states
       (family, generation, entity_id, desired_action, desired_epoch,
        desired_fingerprint, desired_index_id, work_status, applied_action,
        applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
        applied_at, created_at, updated_at)
     VALUES ('case_law', $1, $2, 'upsert', 2, lpad('2', 64, '0'), $3,
       'eligible', 'upsert', 1, $4, lpad('1', 64, '0'), $3, '2026-08-01',
       '2026-08-01', ${FUTURE})`,
    [STORED, entity("namedLive", 1), indexOf(STORED), revision("namedLive", 1)],
  );
  // Untouched: a query-only generation still waits for the delete.
  await insertState({
    generation: QUERY_ONLY,
    role: "queryOnly",
    n: 1,
    queuedAt: FUTURE,
  });
  await insertRevision({
    generation: QUERY_ONLY,
    role: "queryOnly",
    n: 1,
    status: "cleanup_committed",
  });
};

type Queued = Map<string, number>;

const queuedAt = async (): Promise<Queued> =>
  new Map(
    (
      await client.query<{ entity_id: string; updated_at: Date | string }>(
        `SELECT entity_id, updated_at FROM corpus_index_projection_states`,
      )
    ).rows.map(({ entity_id, updated_at }) => [
      entity_id,
      new Date(updated_at).getTime(),
    ]),
  );

const databaseNow = async (): Promise<number> => {
  const row = (
    await client.query<{ now: Date | string }>(`SELECT now() AS now`)
  ).rows.at(0);
  return new Date(row?.now ?? panic("The database clock is missing")).getTime();
};

const WOKEN = new Set([
  ...Array.from({ length: DEFERRED_ROWS }, (_, index) =>
    entity("deferred", index + 1),
  ),
  entity("noRevision", 1),
  entity("deleting", 1),
]);

const IDS_SHA256 = /ids sha256 (?<digest>[0-9a-f]{64})/u;
const digestsOf = (out: string) =>
  [...out.matchAll(new RegExp(IDS_SHA256, "gu"))].map(
    ({ groups }) => groups?.["digest"] ?? panic("no digest"),
  );

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterEach(async () => {
  await client.close();
});

test("a dry run counts the owed states and writes nothing", async () => {
  await seed();
  const before = await queuedAt();
  const dryRun = await wake(["--generation", STORED, "--dry-run"]);
  expect(dryRun.code).toBe(0);
  expect(dryRun.out).toContain(`owed: ${String(WOKEN.size)} deferred state(s)`);
  expect(dryRun.out).toContain("Dry run: nothing written");
  expect(await queuedAt()).toEqual(before);
});

test("apply wakes exactly the states the append walk would take, and a rerun wakes nothing", async () => {
  await seed();
  const before = await queuedAt();
  const dryRun = await wake(["--generation", STORED]);
  const startedAt = await databaseNow();

  const applied = await wake(["--generation", STORED, "--apply"]);
  expect(applied.code).toBe(0);
  expect(applied.out).toContain(`applied: woke ${String(WOKEN.size)} state(s)`);
  expect(applied.out).toContain("left: 0 deferred state(s)");
  // The apply wakes the set the dry run counted.
  expect(digestsOf(applied.out).at(0)).toBe(digestsOf(dryRun.out).at(0));

  const after = await queuedAt();
  const finishedAt = await databaseNow();
  for (const [entityId, was] of before) {
    const now = after.get(entityId) ?? panic(`Lost state ${entityId}`);
    if (WOKEN.has(entityId)) {
      expect(now).toBeGreaterThanOrEqual(startedAt);
      expect(now).toBeLessThanOrEqual(finishedAt);
    } else {
      expect(now).toBe(was);
    }
  }

  const rerun = await wake(["--generation", STORED, "--apply"]);
  expect(rerun.code).toBe(0);
  expect(rerun.out).toContain("owed: 0 deferred state(s)");
  expect(await queuedAt()).toEqual(after);
});

test("a generation whose hits do not carry their revision is refused", async () => {
  await seed();
  const before = await queuedAt();
  const refused = await wake(["--generation", QUERY_ONLY, "--apply"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("does not store its revision");
  expect(await queuedAt()).toEqual(before);
});
