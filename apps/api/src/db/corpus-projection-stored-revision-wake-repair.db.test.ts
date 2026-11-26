import { panic } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createCorpusProjectionStoredRevisionWakeRepair } from "./corpus-projection-stored-revision-wake-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const BATCH = 50;

const REPAIR = createCorpusProjectionStoredRevisionWakeRepair({
  sleep: async () => {},
  batchStates: BATCH,
  readVerdict: async () => ({
    kind: "normal",
    signals: [
      {
        indicator: "ebs_balance",
        kind: "normal",
        value: 90,
        threshold: 70,
        observedAt: "2026-11-26T12:00:00.000Z",
        reason: "Injected health for repair semantics",
      },
    ],
  }),
});

/** v10's hits carry their revision; v7's do not. */
const STORED = "case_law_v10";
const QUERY_ONLY = "case_law_v7";
const indexOf = (generation: string) => `${generation}_pol`;

/** More deferred states than fit one batch, so the wake takes several. */
const DEFERRED_ROWS = 3 * BATCH + 7;

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
} as const;
type Role = keyof typeof ROLE;

const entity = (role: Role, n: number) =>
  `0198e331-e578-7000-8${String(ROLE[role])}00-${String(n).padStart(12, "0")}`;
const revision = (role: Role, n: number) =>
  `0198e331-e578-7000-9${String(ROLE[role])}00-${String(n).padStart(12, "0")}`;

let client: Awaited<ReturnType<typeof createTestPglite>>;

const connectionOver = (): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await client.query(query, [...params]);
  },
  query: async (query, params = []) =>
    (await client.query(query, [...params])).rows,
  release: () => {},
});

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

beforeEach(async () => {
  client = await createTestPglite();
});

afterEach(async () => {
  await client.close();
});

test("a database with nothing deferred owes nothing", async () => {
  const connection = connectionOver();
  expect(await REPAIR.readCompletion(connection)).toEqual({ type: "complete" });
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });
});

test("the wake moves exactly the states the append walk would now take, in batches, and reruns as a no-op", async () => {
  await seed();
  const connection = connectionOver();
  expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");
  const before = await queuedAt();
  const startedAt = await databaseNow();

  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });

  const after = await queuedAt();
  const finishedAt = await databaseNow();
  expect(after.size).toBe(before.size);
  for (const [entityId, was] of before) {
    const now = after.get(entityId) ?? panic(`Lost state ${entityId}`);
    if (WOKEN.has(entityId)) {
      // Runnable now: queued at the instant of its own batch.
      expect(now).toBeGreaterThanOrEqual(startedAt);
      expect(now).toBeLessThanOrEqual(finishedAt);
    } else {
      expect(now).toBe(was);
    }
  }
  expect(await REPAIR.readCompletion(connection)).toEqual({ type: "complete" });

  // Running it again changes nothing.
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });
  expect(await queuedAt()).toEqual(after);
});

test("a run that stops partway is finished by the next one", async () => {
  await seed();
  const connection = connectionOver();
  // One batch, then the process dies: the next run takes only what is left.
  const interrupted = createCorpusProjectionStoredRevisionWakeRepair({
    sleep: async () => {
      throw new TypeError("interrupted");
    },
    batchStates: BATCH,
    readVerdict: async () => ({ kind: "normal", signals: [] }),
  });
  await interrupted
    .repair(connection)
    .catch((error: unknown) =>
      error instanceof TypeError ? undefined : Promise.reject(error),
    );
  const partial = await queuedAt();
  const now = await databaseNow();
  const wokenSoFar = [...WOKEN].filter(
    (entityId) => (partial.get(entityId) ?? Number.POSITIVE_INFINITY) <= now,
  );
  expect(wokenSoFar.length).toBeGreaterThan(0);
  expect(wokenSoFar.length).toBeLessThan(WOKEN.size);
  expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");

  await REPAIR.repair(connection, createUngatedTableGateForTests(connection));
  expect(await REPAIR.readCompletion(connection)).toEqual({ type: "complete" });
  const finished = await queuedAt();
  for (const entityId of WOKEN) {
    expect(
      finished.get(entityId) ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(await databaseNow());
  }
});
