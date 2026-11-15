import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_PROJECTION_SERVING,
  type CorpusIndexProjectionServing,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import {
  CORPUS_PROJECTION_UNSERVED_COUNT_CAP,
  type CorpusProjectionUnservedCursor,
  type CorpusProjectionUnservedEntity,
  type CorpusProjectionUnservedKind,
  type CorpusProjectionUnservedReadError,
  readCorpusProjectionUnservedCountsTx,
  readCorpusProjectionUnservedPageTx,
} from "@/api/lib/legal-search/corpus-index-projection-unserved";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = { family: "case_law", generation: "case_law_v5" } as const;
const INDEX_ID = "case_law_v5_cs_sk";
const ENTITIES = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;
const PAGE_SIZE = 2;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    family: TARGET.family,
    generation: TARGET.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  await run(`
    CREATE FUNCTION pg_temp.unserved_test_now() RETURNS timestamptz
    LANGUAGE sql STABLE
    AS $$ SELECT current_setting('${TEST_NOW_SETTING}')::timestamptz $$
  `);
});

afterAll(async () => {
  await client.close();
});

const run = async (statement: string): Promise<void> => {
  await client.query(statement);
};

/**
 * The model's clock, read in SQL: each transition sets it, and its statements
 * call `pg_temp.unserved_test_now()` for every instant they write.
 */
const TEST_NOW_SETTING = "unserved_test.now";

const at = (tick: number) =>
  `('2026-07-01T00:00:00Z'::timestamptz + ${tick} * INTERVAL '1 second')`;
const fingerprint = (epoch: number) => `lpad('${epoch}', 64, '0')`;

// The model: what the projection has done to each entity, written down
// independently of the SQL that classifies it.

type RevisionStatus =
  | "reserved"
  | "append_started"
  | "append_committed"
  | "applied"
  | "cleanup_pending"
  | "cleanup_started"
  | "cleanup_committed"
  | "cleanup_stalled"
  | "settled"
  | "cancelled";

type ModelRevision = {
  id: string;
  epoch: number;
  status: RevisionStatus;
  /** Whether a cleanup claim has ever taken it, so a delete may have run. */
  claimed: boolean;
};

type ModelEntity = {
  entityId: string;
  desired: { action: "upsert" | "erase"; epoch: number };
  applied:
    | { type: "none" }
    | { type: "erase"; epoch: number }
    | { type: "upsert"; revisionId: string; epoch: number };
  revisions: ModelRevision[];
};

type Model = { tick: number; nextRevision: number; entities: ModelEntity[] };

const expectedServing = (entity: ModelEntity): CorpusIndexProjectionServing => {
  if (entity.desired.action === "erase") {
    return "erased";
  }
  switch (entity.applied.type) {
    case "none":
      return "never_applied";
    case "erase":
      return "absent";
    case "upsert": {
      const { revisionId } = entity.applied;
      const named =
        entity.revisions.find(({ id }) => id === revisionId) ??
        panic("The model names a revision it does not hold");
      if (named.status === "settled") {
        return "absent";
      }
      if (
        named.status === "applied" ||
        (named.status === "cleanup_pending" && !named.claimed)
      ) {
        return "served";
      }
      return "at_risk";
    }
    default:
      entity.applied satisfies never;
      return panic("Unhandled model applied state");
  }
};

const OPERATIONS = [
  "desire_upsert",
  "desire_erase",
  "reserve",
  "cancel",
  "start",
  "record_accepted",
  "prove",
  "fail",
  "prepare_replacement",
  "fence_erasure",
  "apply_erasure",
  "claim_cleanup",
  "expire_cleanup_lease",
  "record_delete",
  "reissue_delete",
  "stall_delete",
  "release_stall",
  "settle",
  "reopen_settled",
] as const;
type Operation = (typeof OPERATIONS)[number];
const TRANSITIONS = OPERATIONS.filter(
  (operation) => operation !== "desire_upsert" && operation !== "desire_erase",
);

const newest = (entity: ModelEntity, status: RevisionStatus) =>
  entity.revisions.findLast((revision) => revision.status === status);

const named = ({ applied, revisions }: ModelEntity) =>
  applied.type === "upsert"
    ? revisions.find(({ id }) => id === applied.revisionId)
    : undefined;

const quiescent = (entity: ModelEntity) =>
  entity.revisions.every(
    ({ status }) => status === "settled" || status === "cancelled",
  );

const updateIntent = async (
  revision: ModelRevision,
  status: RevisionStatus,
  set: string,
): Promise<void> => {
  await run(`
    UPDATE corpus_index_projection_intents
    SET status = '${status}', ${set}
    WHERE id = '${revision.id}'
  `);
  revision.status = status;
};

/**
 * One writer transition as the writers of this and the previous release make
 * it: the same columns, through plain statements, and nothing the
 * classification adds, because it adds nothing to write.
 */
const applyOperation = async (
  model: Model,
  entity: ModelEntity,
  operation: Operation,
): Promise<void> => {
  model.tick += 1;
  await run(
    `SELECT set_config('${TEST_NOW_SETTING}', ${at(model.tick)}::text, false)`,
  );
  const where = `family = '${TARGET.family}' AND generation = '${TARGET.generation}' AND entity_id = '${entity.entityId}'`;
  switch (operation) {
    case "desire_upsert": {
      const epoch = entity.desired.epoch + 1;
      await run(`
        UPDATE corpus_index_projection_states
        SET desired_action = 'upsert', desired_epoch = ${epoch},
            desired_fingerprint = ${fingerprint(epoch)},
            desired_index_id = '${INDEX_ID}', desired_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()
        WHERE ${where}
      `);
      entity.desired = { action: "upsert", epoch };
      return;
    }
    case "desire_erase": {
      const epoch = entity.desired.epoch + 1;
      await run(`
        UPDATE corpus_index_projection_states
        SET desired_action = 'erase', desired_epoch = ${epoch},
            desired_fingerprint = NULL, desired_index_id = NULL,
            desired_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()
        WHERE ${where}
      `);
      entity.desired = { action: "erase", epoch };
      return;
    }
    case "reserve": {
      // Delete-first: a reservation waits until nothing of the entity is left
      // in the index, the named revision included.
      if (entity.desired.action !== "upsert" || !quiescent(entity)) {
        return;
      }
      const id = `00000000-0000-4000-9000-${String(model.nextRevision).padStart(12, "0")}`;
      model.nextRevision += 1;
      const { epoch } = entity.desired;
      await run(`
        INSERT INTO corpus_index_projection_intents
          (id, family, generation, entity_id, epoch, fingerprint, index_id,
           status, lease_token, lease_expires_at, created_at, updated_at)
        VALUES
          ('${id}', '${TARGET.family}', '${TARGET.generation}', '${entity.entityId}',
           ${epoch}, ${fingerprint(epoch)}, '${INDEX_ID}', 'reserved',
           '00000000-0000-4000-a000-000000000001', pg_temp.unserved_test_now() + INTERVAL '1 hour',
           pg_temp.unserved_test_now(), pg_temp.unserved_test_now())
      `);
      entity.revisions.push({ id, epoch, status: "reserved", claimed: false });
      return;
    }
    case "cancel": {
      const revision = newest(entity, "reserved");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "cancelled",
          `lease_token = NULL, lease_expires_at = NULL, cancelled_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "start": {
      const revision = newest(entity, "reserved");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "append_started",
          `append_started_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "record_accepted": {
      const revision = newest(entity, "append_started");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "append_committed",
          `lease_token = NULL, lease_expires_at = NULL,
           append_committed_at = pg_temp.unserved_test_now(), append_publish_barrier_at = pg_temp.unserved_test_now(),
           expected_document_count = 3, updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "prove": {
      const revision = newest(entity, "append_committed");
      if (
        revision === undefined ||
        entity.desired.action !== "upsert" ||
        revision.epoch !== entity.desired.epoch
      ) {
        return;
      }
      await updateIntent(
        revision,
        "applied",
        `applied_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()`,
      );
      await run(`
        UPDATE corpus_index_projection_states
        SET applied_action = 'upsert', applied_epoch = ${revision.epoch},
            applied_revision = '${revision.id}',
            applied_fingerprint = ${fingerprint(revision.epoch)},
            applied_index_id = '${INDEX_ID}', applied_at = pg_temp.unserved_test_now(),
            work_status = 'eligible', retry_not_before = NULL,
            failure_attempts = 0, last_failure_kind = NULL,
            last_failure_message = NULL, updated_at = pg_temp.unserved_test_now()
        WHERE ${where}
      `);
      entity.applied = {
        type: "upsert",
        revisionId: revision.id,
        epoch: revision.epoch,
      };
      return;
    }
    case "fail": {
      const revision =
        newest(entity, "append_started") ?? newest(entity, "append_committed");
      if (revision === undefined) {
        return;
      }
      await updateIntent(
        revision,
        "cleanup_pending",
        `lease_token = NULL, lease_expires_at = NULL,
         append_publish_barrier_at = coalesce(append_publish_barrier_at, pg_temp.unserved_test_now()),
         cleanup_not_before = pg_temp.unserved_test_now(), last_error = 'append failed', updated_at = pg_temp.unserved_test_now()`,
      );
      await run(`
        UPDATE corpus_index_projection_states
        SET work_status = 'retry_scheduled', retry_not_before = pg_temp.unserved_test_now(),
            failure_attempts = failure_attempts + 1,
            last_failure_kind = 'append_transient',
            last_failure_message = 'append failed', updated_at = pg_temp.unserved_test_now()
        WHERE ${where}
      `);
      return;
    }
    case "prepare_replacement":
    case "fence_erasure": {
      const revision = named(entity);
      const wanted =
        operation === "prepare_replacement"
          ? entity.desired.action === "upsert" &&
            entity.applied.type === "upsert" &&
            entity.desired.epoch > entity.applied.epoch
          : entity.desired.action === "erase";
      if (revision?.status !== "applied" || !wanted) {
        return;
      }
      await updateIntent(
        revision,
        "cleanup_pending",
        `append_publish_barrier_at = coalesce(append_publish_barrier_at, applied_at),
         cleanup_not_before = pg_temp.unserved_test_now(),
         last_error = ${operation === "fence_erasure" ? "'erased'" : "NULL"},
         updated_at = pg_temp.unserved_test_now()`,
      );
      return;
    }
    case "apply_erasure": {
      if (entity.desired.action !== "erase" || !quiescent(entity)) {
        return;
      }
      await run(`
        UPDATE corpus_index_projection_states
        SET applied_action = 'erase', applied_epoch = desired_epoch,
            applied_revision = NULL, applied_fingerprint = NULL,
            applied_index_id = NULL, applied_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()
        WHERE ${where}
      `);
      entity.applied = { type: "erase", epoch: entity.desired.epoch };
      return;
    }
    case "claim_cleanup": {
      const revision = newest(entity, "cleanup_pending");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "cleanup_started",
          `lease_token = '00000000-0000-4000-a000-000000000002',
           lease_expires_at = pg_temp.unserved_test_now() + INTERVAL '1 hour',
           cleanup_started_at = pg_temp.unserved_test_now(),
           cleanup_attempts = cleanup_attempts + 1, updated_at = pg_temp.unserved_test_now()`,
        );
        revision.claimed = true;
      }
      return;
    }
    case "expire_cleanup_lease": {
      const revision = newest(entity, "cleanup_started");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "cleanup_pending",
          `lease_token = NULL, lease_expires_at = NULL, cleanup_started_at = NULL,
           last_error = 'projection cleanup lease expired with unknown outcome',
           updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "record_delete": {
      const revision = newest(entity, "cleanup_started");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "cleanup_committed",
          `lease_token = NULL, lease_expires_at = NULL, delete_opstamp = ${model.tick},
           delete_task_created_at = pg_temp.unserved_test_now(), last_error = NULL, updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "reissue_delete":
    case "release_stall": {
      const revision =
        operation === "reissue_delete"
          ? newest(entity, "cleanup_committed")
          : newest(entity, "cleanup_stalled");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "cleanup_pending",
          `cleanup_not_before = pg_temp.unserved_test_now(), cleanup_started_at = NULL,
           delete_opstamp = NULL, delete_task_created_at = NULL,
           delete_reissues = delete_reissues + 1, updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "stall_delete": {
      const revision = newest(entity, "cleanup_committed");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "cleanup_stalled",
          `updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "settle": {
      const revision = newest(entity, "cleanup_committed");
      if (revision !== undefined) {
        await updateIntent(
          revision,
          "settled",
          `settled_at = pg_temp.unserved_test_now(), updated_at = pg_temp.unserved_test_now()`,
        );
      }
      return;
    }
    case "reopen_settled": {
      const revision = newest(entity, "settled");
      if (revision === undefined) {
        return;
      }
      // As the cleanup reopen does: an erased state whose erasure covered the
      // reopened revision forgets the erasure, so the claim applies it again.
      if (
        entity.applied.type === "erase" &&
        revision.epoch <= entity.applied.epoch
      ) {
        await run(`
          UPDATE corpus_index_projection_states
          SET applied_action = NULL, applied_epoch = NULL, applied_revision = NULL,
              applied_fingerprint = NULL, applied_index_id = NULL,
              applied_at = NULL, updated_at = pg_temp.unserved_test_now()
          WHERE ${where}
        `);
        entity.applied = { type: "none" };
      }
      await updateIntent(
        revision,
        "cleanup_pending",
        `cleanup_not_before = pg_temp.unserved_test_now(), cleanup_started_at = NULL,
         delete_opstamp = NULL, delete_task_created_at = NULL,
         settled_at = NULL, last_error = 'reopened', updated_at = pg_temp.unserved_test_now()`,
      );
      return;
    }
    default:
      operation satisfies never;
      return panic("Unhandled model operation");
  }
};

/**
 * Apply the drawn operation to the drawn entity, or else the next entity it
 * applies to, or else the next operation that applies at all, so every step
 * moves some entity and deep states (a replacement whose old copy settled)
 * are reached within a short sequence. An operation that does not apply
 * returns before it writes anything.
 */
const applyFirstEnabled = async (
  model: Model,
  { entity: first, operation: drawn }: { entity: number; operation: number },
): Promise<void> => {
  const drawnOperation = OPERATIONS.at(drawn) ?? panic("No such operation");
  // A desired-state change always applies, so it is tried only when drawn:
  // as a fallback it would crowd out every transition it interrupts.
  const fallbacks = TRANSITIONS.map(
    (_, step) =>
      TRANSITIONS.at((drawn + step) % TRANSITIONS.length) ??
      panic("No such transition"),
  );
  for (const operation of [drawnOperation, ...fallbacks]) {
    for (let offset = 0; offset < model.entities.length; offset += 1) {
      const entity =
        model.entities.at((first + offset) % model.entities.length) ??
        panic("No such model entity");
      const before = JSON.stringify(entity);
      // db-await-in-loop: stops at the first operation that changes an entity
      await applyOperation(model, entity, operation);
      if (JSON.stringify(entity) !== before) {
        return;
      }
    }
  }
};

const observedServing = new Set<string>();
/** Each named revision's status and claim, as `status` or `status+claimed`. */
const observedNamed = new Set<string>();

const resetGeneration = async (model: Model): Promise<void> => {
  await run(
    `DELETE FROM corpus_index_projection_states WHERE generation = '${TARGET.generation}'`,
  );
  await run(
    `DELETE FROM corpus_index_projection_intents WHERE generation = '${TARGET.generation}'`,
  );
  for (const entity of model.entities) {
    await run(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, created_at, updated_at)
      VALUES
        ('${TARGET.family}', '${TARGET.generation}', '${entity.entityId}', 'upsert', 1,
         ${fingerprint(1)}, '${INDEX_ID}', ${at(0)}, ${at(0)})
    `);
  }
};

const servingCase = sql.join(
  [
    sql`CASE`,
    ...Object.entries(CORPUS_INDEX_PROJECTION_SERVING).map(
      ([serving, predicate]) =>
        sql`WHEN ${predicate({
          state: corpusIndexProjectionStates,
          revision: corpusIndexProjectionIntents,
        })} THEN ${serving}`,
    ),
    sql`END`,
  ],
  sql` `,
);

const branchesMatched = sql.join(
  Object.values(CORPUS_INDEX_PROJECTION_SERVING).map(
    (predicate) =>
      sql`coalesce(${predicate({
        state: corpusIndexProjectionStates,
        revision: corpusIndexProjectionIntents,
      })}, false)::int`,
  ),
  sql` + `,
);

const okValue = <T>(result: Result<T, CorpusProjectionUnservedReadError>): T =>
  Result.isError(result)
    ? panic("An unserved projection read failed", result.error)
    : result.value;

const readCounts = async () =>
  okValue(
    await db.transaction(
      async (tx) =>
        await readCorpusProjectionUnservedCountsTx(
          asTestRaw<Transaction>(tx),
          TARGET,
        ),
    ),
  );

const readServing = async (): Promise<
  Map<string, { serving: unknown; matched: unknown }>
> => {
  const rows = executedRows(
    await db.execute(sql`
      SELECT ${corpusIndexProjectionStates.entityId}::text AS entity_id,
        ${servingCase} AS serving,
        (${branchesMatched})::int AS matched
      FROM ${corpusIndexProjectionStates}
      LEFT JOIN ${corpusIndexProjectionIntents}
        ON ${corpusIndexProjectionIntents.id} = ${corpusIndexProjectionStates.appliedRevision}
      WHERE ${corpusIndexProjectionStates.generation} = ${TARGET.generation}
    `),
  );
  return new Map(
    rows.map((row) => {
      if (!isRecord(row) || typeof row["entity_id"] !== "string") {
        return panic("Malformed serving row");
      }
      return [
        row["entity_id"],
        { serving: row["serving"], matched: row["matched"] },
      ];
    }),
  );
};

const readPage = async (
  kind: CorpusProjectionUnservedKind,
  after: CorpusProjectionUnservedCursor | null,
) =>
  await db.transaction(async (tx) => {
    switch (kind) {
      case "at_risk":
        return await readCorpusProjectionUnservedPageTx(
          asTestRaw<Transaction>(tx),
          {
            ...TARGET,
            kind,
            limit: PAGE_SIZE,
            after: after?.kind === "at_risk" ? after : null,
          },
        );
      case "absent":
        return await readCorpusProjectionUnservedPageTx(
          asTestRaw<Transaction>(tx),
          {
            ...TARGET,
            kind,
            limit: PAGE_SIZE,
            after: after?.kind === "absent" ? after : null,
          },
        );
      default:
        kind satisfies never;
        return panic("Unhandled unserved kind");
    }
  });

/** Every entity of a kind, page by page from the keyset cursor. */
const readAllPages = async (
  kind: CorpusProjectionUnservedKind,
  after: CorpusProjectionUnservedCursor | null = null,
): Promise<CorpusProjectionUnservedEntity[]> => {
  const { entities, next } = okValue(await readPage(kind, after));
  return next === null
    ? [...entities]
    : [...entities, ...(await readAllPages(kind, next))];
};

const assertMatchesModel = async (model: Model): Promise<void> => {
  const serving = await readServing();
  for (const entity of model.entities) {
    const expected = expectedServing(entity);
    observedServing.add(expected);
    const revision = named(entity);
    if (revision !== undefined) {
      observedNamed.add(
        revision.claimed ? `${revision.status}+claimed` : revision.status,
      );
    }
    expect(serving.get(entity.entityId)).toEqual({
      serving: expected,
      matched: 1,
    });
  }
  const counts = await readCounts();
  for (const kind of ["at_risk", "absent"] as const) {
    const expected = model.entities
      .filter((entity) => expectedServing(entity) === kind)
      .map(({ entityId }) => entityId)
      .toSorted();
    const listed = await readAllPages(kind);
    expect(listed.map(({ entityId }) => entityId).toSorted()).toEqual(expected);
    expect(counts[kind].type).toBe("exact");
    const oldest = listed
      .map(({ unservedSince }) => unservedSince)
      .toSorted(Temporal.Instant.compare)
      .at(0);
    expect(counts[kind].byIndex).toEqual(
      oldest === undefined
        ? []
        : [
            {
              indexId: INDEX_ID,
              count: expected.length,
              oldest: { type: "exact", since: oldest },
            },
          ],
    );
    if (kind === "at_risk") {
      const since = listed.map(
        ({ unservedSince }) => unservedSince.epochNanoseconds,
      );
      expect(since).toEqual(
        since.toSorted((left, right) => Number(left - right)),
      );
    }
  }
};

describe("unserved projection classification", () => {
  test(
    "corpus-projection.unserved-classification",
    async () => {
      await assertProperty(
        "corpus-projection.unserved-classification",
        fc.asyncProperty(
          fc.array(
            fc.record({
              entity: fc.noBias(
                fc.integer({ min: 0, max: ENTITIES.length - 1 }),
              ),
              operation: fc.noBias(
                fc.integer({ min: 0, max: OPERATIONS.length - 1 }),
              ),
            }),
            { minLength: 40, maxLength: 100 },
          ),
          async (steps) => {
            const model: Model = {
              tick: 0,
              nextRevision: 1,
              entities: ENTITIES.map((entityId) => ({
                entityId,
                desired: { action: "upsert", epoch: 1 },
                applied: { type: "none" },
                revisions: [],
              })),
            };
            await resetGeneration(model);
            for (const step of steps) {
              // db-await-in-loop: the steps are the sequence under test
              await applyFirstEnabled(model, step);
              // db-await-in-loop: the invariant holds after every step
              await assertMatchesModel(model);
            }
          },
        ),
        { numRuns: 64 },
      );
      // The generator must reach every branch, or the property proves less
      // than it claims.
      expect([...observedServing].toSorted()).toEqual(
        Object.keys(CORPUS_INDEX_PROJECTION_SERVING).toSorted(),
      );
      expect([...observedNamed].toSorted()).toEqual([
        "applied",
        "cleanup_committed+claimed",
        "cleanup_pending",
        "cleanup_pending+claimed",
        "cleanup_stalled+claimed",
        "cleanup_started+claimed",
        "settled+claimed",
      ]);
    },
    propertyTestTimeout(300_000),
  );
});

describe("unserved gauge counts", () => {
  /** One row in every serving branch, the defect branches more than once. */
  const seedEveryBranch = async (): Promise<void> => {
    const model: Model = {
      tick: 0,
      nextRevision: 100,
      entities: Array.from({ length: 8 }, (_, offset) => ({
        entityId: `00000000-0000-4000-8000-0000000001${String(offset).padStart(2, "0")}`,
        desired: { action: "upsert", epoch: 1 },
        applied: { type: "none" },
        revisions: [],
      })),
    };
    await resetGeneration(model);
    const appliedAt = async (entity: ModelEntity) => {
      for (const operation of [
        "reserve",
        "start",
        "record_accepted",
        "prove",
        "desire_upsert",
        "prepare_replacement",
      ] as const) {
        // db-await-in-loop: one entity's transitions, in order
        await applyOperation(model, entity, operation);
      }
    };
    const [
      neverApplied,
      servedStale,
      atRiskClaimed,
      atRiskCommitted,
      absentSettled,
      absentErased,
      erased,
      returned,
    ] = model.entities;
    if (
      neverApplied === undefined ||
      servedStale === undefined ||
      atRiskClaimed === undefined ||
      atRiskCommitted === undefined ||
      absentSettled === undefined ||
      absentErased === undefined ||
      erased === undefined ||
      returned === undefined
    ) {
      return panic("Seed entities are missing");
    }
    for (const entity of [
      servedStale,
      atRiskClaimed,
      atRiskCommitted,
      absentSettled,
      returned,
    ]) {
      // db-await-in-loop: a fixed set of seeded entities
      await appliedAt(entity);
    }
    await applyOperation(model, atRiskClaimed, "claim_cleanup");
    for (const operation of ["claim_cleanup", "record_delete"] as const) {
      // db-await-in-loop: one entity's transitions, in order
      await applyOperation(model, atRiskCommitted, operation);
    }
    for (const operation of [
      "claim_cleanup",
      "record_delete",
      "settle",
    ] as const) {
      // db-await-in-loop: one entity's transitions, in order
      await applyOperation(model, absentSettled, operation);
    }
    for (const operation of [
      "claim_cleanup",
      "expire_cleanup_lease",
    ] as const) {
      // db-await-in-loop: one entity's transitions, in order
      await applyOperation(model, returned, operation);
    }
    for (const operation of [
      "desire_erase",
      "apply_erasure",
      "desire_upsert",
    ] as const) {
      // db-await-in-loop: one entity's transitions, in order
      await applyOperation(model, absentErased, operation);
    }
    await applyOperation(model, erased, "desire_erase");
    expect(model.entities.map((entity) => expectedServing(entity))).toEqual([
      "never_applied",
      "served",
      "at_risk",
      "at_risk",
      "absent",
      "absent",
      "erased",
      "at_risk",
    ]);
  };

  test("each defect branch counts once, per index, and nothing else counts", async () => {
    await seedEveryBranch();
    const counts = await readCounts();
    expect(
      Object.fromEntries(
        Object.entries(counts).map(([kind, count]) => [
          kind,
          {
            type: count.type,
            counts: count.byIndex.map(({ count: value }) => value),
          },
        ]),
      ),
    ).toEqual({
      at_risk: { type: "exact", counts: [3] },
      absent: { type: "exact", counts: [2] },
    });
  });

  test("past the cap the count is a lower bound and the oldest stays exact", async () => {
    const seeded = CORPUS_PROJECTION_UNSERVED_COUNT_CAP + 5;
    await resetGeneration({ tick: 0, nextRevision: 1, entities: [] });
    const entity = `('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid`;
    const revision = `('00000000-0000-4000-9000-' || lpad(to_hex(i), 12, '0'))::uuid`;
    await run(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         append_publish_barrier_at, applied_at, cleanup_not_before,
         cleanup_started_at, cleanup_attempts, delete_opstamp,
         delete_task_created_at, created_at, updated_at)
      SELECT ${revision}, '${TARGET.family}', '${TARGET.generation}', ${entity}, 1,
        ${fingerprint(1)}, '${INDEX_ID}', 'cleanup_committed', 3,
        ${at(0)}, ${at(0)}, ${at(0)}, ${at(0)}, ${at(0)},
        ${at(1)} + i * INTERVAL '1 second', 1, i, ${at(0)}, ${at(0)}, ${at(0)}
      FROM generate_series(1, ${seeded}) AS i
    `);
    await run(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, applied_action, applied_epoch,
         applied_revision, applied_fingerprint, applied_index_id, applied_at,
         created_at, updated_at)
      SELECT '${TARGET.family}', '${TARGET.generation}', ${entity}, 'upsert', 2,
        ${fingerprint(2)}, '${INDEX_ID}', 'upsert', 1, ${revision},
        ${fingerprint(1)}, '${INDEX_ID}', ${at(0)}, ${at(0)}, ${at(0)}
      FROM generate_series(1, ${seeded}) AS i
    `);
    const counts = await readCounts();
    const [index] = counts.at_risk.byIndex;
    expect(counts.at_risk.type).toBe("at_least");
    expect(index?.count).toBe(CORPUS_PROJECTION_UNSERVED_COUNT_CAP + 1);
    expect(index?.oldest).toEqual({
      type: "exact",
      since: Temporal.Instant.from("2026-07-01T00:00:02Z"),
    });
    const listed = await readAllPages("at_risk");
    expect(listed).toHaveLength(seeded);
  });
});
