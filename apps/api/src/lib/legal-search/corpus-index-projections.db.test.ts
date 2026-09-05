import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  canTransitionCorpusIndexIntent,
  CORPUS_INDEX_INTENT_STATUSES,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MIGRATION_URLS = [
  new URL(
    "../../../drizzle/20260825142000_corpus_index_projection_intents/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../drizzle/20260825211300_corpus_projection_delete_guard_record/migration.sql",
    import.meta.url,
  ),
] as const;
const SOURCE_ID = "0198e331-e578-7000-8000-000000000001";
const FIRST_DECISION_ID = "0198e331-e578-7000-8000-000000000002";
const RACED_DECISION_ID = "0198e331-e578-7000-8000-000000000003";
const FIRST_REVISION = "0198e331-e578-7000-8000-000000000004";
const RACED_REVISION = "0198e331-e578-7000-8000-000000000005";
const LEASE_TOKEN = "0198e331-e578-7000-8000-000000000006";
const SECOND_REVISION = "0198e331-e578-7000-8000-000000000007";
const LEGISLATION_SOURCE_ID = "0198e331-e578-7000-8000-000000000008";
const LEGISLATION_DOCUMENT_ID = "0198e331-e578-7000-8000-000000000009";
const LEGISLATION_REVISION = "0198e331-e578-7000-8000-000000000010";
const RETIRED_DECISION_ID = "0198e331-e578-7000-8000-000000000011";
const RETIRED_REVISION = "0198e331-e578-7000-8000-000000000012";
const FIRST_FINGERPRINT = "a".repeat(64);
const SECOND_FINGERPRINT = "b".repeat(64);
const MANIFEST_DIGEST = "c".repeat(64);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const rejectionMessage = async (run: Promise<unknown>): Promise<string> =>
  await run.then(
    () => "no rejection",
    (error: unknown) => errorMessageChain(error),
  );

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.execute(sql`
      INSERT INTO case_law_sources (id, adapter_key, name)
      VALUES (${SOURCE_ID}, 'projection-contract-test', 'Projection contract test')
    `);
    await db.execute(sql`
      INSERT INTO case_law_decisions (
        id, source_id, case_number, court, country, language, fulltext,
        projection_epoch
      ) VALUES
        (${FIRST_DECISION_ID}, ${SOURCE_ID}, '1 A 1/2026', 'Test court', 'CZE', 'cs', 'first', 1),
        (${RACED_DECISION_ID}, ${SOURCE_ID}, '1 A 2/2026', 'Test court', 'CZE', 'cs', 'raced', 1)
    `);
    await db.execute(sql`
      INSERT INTO corpus_index_generations (
        family, generation, cluster, manifest_digest, status
      ) VALUES
        ('case_law', 'case_law_v5', 'q09', ${MANIFEST_DIGEST}, 'building'),
        ('legislation', 'legislation_v2', 'q09', ${MANIFEST_DIGEST}, 'building')
    `);
    await db.execute(sql`
      INSERT INTO legislation_sources (id, adapter_key, name)
      VALUES (
        ${LEGISLATION_SOURCE_ID}, 'projection-contract-test',
        'Projection contract test'
      )
    `);
    await db.execute(sql`
      INSERT INTO legislation_documents (
        id, source_id, eli, title, country, language, projection_epoch
      ) VALUES (
        ${LEGISLATION_DOCUMENT_ID}, ${LEGISLATION_SOURCE_ID},
        'eli/cz/test', 'Test act', 'CZE', 'cs', 1
      )
    `);

    for (const migrationUrl of MIGRATION_URLS) {
      const migration = await Bun.file(migrationUrl).text();
      for (const statement of migration.split("--> statement-breakpoint")) {
        const ddl = statement.trim();
        const uncommentedDdl = ddl.replace(/^(?:--[^\n]*(?:\n|$)\s*)+/u, "");
        if (
          !uncommentedDdl.startsWith("CREATE FUNCTION") &&
          !uncommentedDdl.startsWith("CREATE OR REPLACE FUNCTION") &&
          !uncommentedDdl.startsWith("CREATE TRIGGER") &&
          !uncommentedDdl.includes(
            'FUNCTION "purge_retired_corpus_index_projection_history"',
          )
        ) {
          continue;
        }
        await db.execute(sql.raw(ddl));
      }
    }
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("one exact append revision becomes authoritative", async () => {
  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_projection_states (
          family, generation, entity_id, desired_action, desired_epoch,
          desired_fingerprint, desired_index_id
        ) VALUES (
          'case_law', 'case_law_v5', ${FIRST_DECISION_ID}, 'upsert', 1, NULL,
          'case_law_v5_cs_sk'
        )
      `),
    ),
  ).toContain("corpus_index_projection_states_desired_shape");

  await db.execute(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id
    ) VALUES (
      'case_law', 'case_law_v5', ${FIRST_DECISION_ID}, 'upsert', 1,
      ${FIRST_FINGERPRINT}, 'case_law_v5_cs_sk'
    )
  `);
  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_projection_intents (
          id, family, generation, entity_id, epoch, fingerprint, index_id,
          status, append_started_at, append_committed_at,
          expected_document_count, applied_at
        ) VALUES (
          '0198e331-e578-7000-8000-000000000098', 'case_law', 'case_law_v5',
          ${FIRST_DECISION_ID}, 1, ${FIRST_FINGERPRINT},
          'case_law_v5_cs_sk', 'applied', clock_timestamp(),
          clock_timestamp(), 1, clock_timestamp()
        )
      `),
    ),
  ).toContain("corpus index projection intent must start reserved");
  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_projection_intents (
          id, family, generation, entity_id, epoch, fingerprint, index_id,
          status, lease_token, lease_expires_at
        ) VALUES (
          '0198e331-e578-7000-8000-000000000097', 'case_law', 'case_law_v5',
          ${FIRST_DECISION_ID}, 1, ${FIRST_FINGERPRINT}, 'case_law_v5_eu',
          'reserved', ${LEASE_TOKEN}, clock_timestamp() + interval '5 minutes'
        )
      `),
    ),
  ).toContain("corpus index projection intent does not match desired state");
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id,
      status, lease_token, lease_expires_at
    ) VALUES (
      ${FIRST_REVISION}, 'case_law', 'case_law_v5', ${FIRST_DECISION_ID}, 1,
      ${FIRST_FINGERPRINT}, 'case_law_v5_cs_sk', 'reserved', ${LEASE_TOKEN},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started', append_started_at = clock_timestamp()
    WHERE id = ${FIRST_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_committed', expected_document_count = 1,
        append_committed_at = clock_timestamp()
    WHERE id = ${FIRST_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'applied', applied_at = clock_timestamp(),
        lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${FIRST_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_states
    SET applied_action = 'upsert', applied_epoch = 1,
        applied_revision = ${FIRST_REVISION},
        applied_fingerprint = ${FIRST_FINGERPRINT},
        applied_index_id = 'case_law_v5_cs_sk',
        applied_at = clock_timestamp()
    WHERE family = 'case_law'
      AND generation = 'case_law_v5'
      AND entity_id = ${FIRST_DECISION_ID}
  `);

  const state = await db.execute<{
    applied_revision: string;
    applied_index_id: string;
    desired_epoch: number;
    desired_index_id: string;
    applied_epoch: number;
  }>(sql`
    SELECT applied_revision, applied_index_id, desired_epoch,
           desired_index_id, applied_epoch
    FROM corpus_index_projection_states
    WHERE entity_id = ${FIRST_DECISION_ID}
  `);
  expect(state.rows).toEqual([
    {
      applied_revision: FIRST_REVISION,
      applied_index_id: "case_law_v5_cs_sk",
      desired_epoch: 1,
      desired_index_id: "case_law_v5_cs_sk",
      applied_epoch: 1,
    },
  ]);

  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_projection_intents (
          id, family, generation, entity_id, epoch, fingerprint, index_id,
          status, lease_token, lease_expires_at
        ) VALUES (
          '0198e331-e578-7000-8000-000000000099', 'case_law', 'case_law_v5',
          ${FIRST_DECISION_ID}, 1, ${FIRST_FINGERPRINT},
          'case_law_v5_cs_sk', 'reserved', ${LEASE_TOKEN},
          clock_timestamp() + interval '5 minutes'
        )
      `),
    ),
  ).toContain("corpus_index_projection_intents_append_epoch_uidx");

  await db.execute(sql`
    UPDATE case_law_decisions SET projection_epoch = 2
    WHERE id = ${FIRST_DECISION_ID}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_states
    SET desired_epoch = 2, desired_fingerprint = ${SECOND_FINGERPRINT},
        desired_index_id = 'case_law_v5_cs_sk'
    WHERE family = 'case_law'
      AND generation = 'case_law_v5'
      AND entity_id = ${FIRST_DECISION_ID}
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id,
      status, lease_token, lease_expires_at
    ) VALUES (
      ${SECOND_REVISION}, 'case_law', 'case_law_v5', ${FIRST_DECISION_ID}, 2,
      ${SECOND_FINGERPRINT}, 'case_law_v5_cs_sk', 'reserved', ${LEASE_TOKEN},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_projection_intents
        SET status = 'cleanup_pending',
            append_publish_barrier_at = clock_timestamp(),
            cleanup_not_before = clock_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${FIRST_REVISION}
      `),
    ),
  ).toContain(
    "current corpus index projection revision requires a replacement before cleanup",
  );
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started', append_started_at = clock_timestamp()
    WHERE id = ${SECOND_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_committed', expected_document_count = 1,
        append_committed_at = clock_timestamp()
    WHERE id = ${SECOND_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'applied', applied_at = clock_timestamp(),
        lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${SECOND_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_states
    SET applied_epoch = 2, applied_revision = ${SECOND_REVISION},
        applied_fingerprint = ${SECOND_FINGERPRINT},
        applied_index_id = 'case_law_v5_cs_sk',
        applied_at = clock_timestamp()
    WHERE family = 'case_law'
      AND generation = 'case_law_v5'
      AND entity_id = ${FIRST_DECISION_ID}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending',
        append_publish_barrier_at = clock_timestamp(),
        cleanup_not_before = clock_timestamp(),
        lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${FIRST_REVISION}
  `);

  const revisions = await db.execute<{ id: string; status: string }>(sql`
    SELECT id, status
    FROM corpus_index_projection_intents
    WHERE entity_id = ${FIRST_DECISION_ID}
    ORDER BY epoch
  `);
  expect(revisions.rows).toEqual([
    { id: FIRST_REVISION, status: "cleanup_pending" },
    { id: SECOND_REVISION, status: "applied" },
  ]);

  expect(
    await rejectionMessage(
      db.execute(sql`
        DELETE FROM corpus_index_projection_states
        WHERE family = 'case_law'
          AND generation = 'case_law_v5'
          AND entity_id = ${FIRST_DECISION_ID}
      `),
    ),
  ).toContain("projection history requires a retired generation");
});

test("an erasure epoch fences an in-flight append until exact cleanup settles", async () => {
  await db.execute(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id
    ) VALUES (
      'case_law', 'case_law_v5', ${RACED_DECISION_ID}, 'upsert', 1,
      ${FIRST_FINGERPRINT}, 'case_law_v5_cs_sk'
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id,
      status, lease_token, lease_expires_at
    ) VALUES (
      ${RACED_REVISION}, 'case_law', 'case_law_v5', ${RACED_DECISION_ID}, 1,
      ${FIRST_FINGERPRINT}, 'case_law_v5_cs_sk', 'reserved', ${LEASE_TOKEN},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started', append_started_at = clock_timestamp()
    WHERE id = ${RACED_REVISION}
  `);

  await db.execute(sql`
    UPDATE case_law_decisions SET projection_epoch = 2
    WHERE id = ${RACED_DECISION_ID}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_states
    SET desired_action = 'erase', desired_epoch = 2,
        desired_fingerprint = NULL, desired_index_id = NULL
    WHERE family = 'case_law'
      AND generation = 'case_law_v5'
      AND entity_id = ${RACED_DECISION_ID}
  `);

  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_projection_intents
        SET status = 'append_committed', expected_document_count = 1,
            append_committed_at = clock_timestamp()
        WHERE id = ${RACED_REVISION}
      `),
    ),
  ).toContain("stale corpus index projection intent cannot advance");

  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_projection_states
        SET applied_action = 'erase', applied_epoch = 2,
            applied_revision = NULL, applied_fingerprint = NULL,
            applied_index_id = NULL,
            applied_at = clock_timestamp()
        WHERE family = 'case_law'
          AND generation = 'case_law_v5'
          AND entity_id = ${RACED_DECISION_ID}
      `),
    ),
  ).toContain(
    "erased corpus index state requires every prior revision settled",
  );

  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending',
        lease_token = NULL, lease_expires_at = NULL,
        append_publish_barrier_at = clock_timestamp() + interval '1 second',
        cleanup_not_before = clock_timestamp() + interval '1 second'
    WHERE id = ${RACED_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_started', cleanup_started_at = cleanup_not_before
    WHERE id = ${RACED_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_committed', delete_opstamp = 42
    WHERE id = ${RACED_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'settled', settled_at = cleanup_started_at
    WHERE id = ${RACED_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_states
    SET applied_action = 'erase', applied_epoch = 2,
        applied_revision = NULL, applied_fingerprint = NULL,
        applied_index_id = NULL,
        applied_at = clock_timestamp()
    WHERE family = 'case_law'
      AND generation = 'case_law_v5'
      AND entity_id = ${RACED_DECISION_ID}
  `);

  const result = await db.execute<{
    applied_action: string;
    applied_epoch: number;
    status: string;
  }>(sql`
    SELECT state.applied_action, state.applied_epoch, intent.status
    FROM corpus_index_projection_states state
    JOIN corpus_index_projection_intents intent
      ON intent.id = ${RACED_REVISION}
    WHERE state.entity_id = ${RACED_DECISION_ID}
  `);
  expect(result.rows).toEqual([
    { applied_action: "erase", applied_epoch: 2, status: "settled" },
  ]);
});

test("epochs and intent identities cannot move backward or retarget", async () => {
  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE case_law_decisions SET projection_epoch = 0
        WHERE id = ${FIRST_DECISION_ID}
      `),
    ),
  ).toContain("corpus projection epoch cannot decrease");
  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_projection_intents
        SET fingerprint = ${SECOND_FINGERPRINT}
        WHERE id = ${FIRST_REVISION}
      `),
    ),
  ).toContain("corpus index projection intent identity is immutable");
});

test("the database transition function matches the exhaustive TypeScript matrix", async () => {
  const values = sql.join(
    CORPUS_INDEX_INTENT_STATUSES.map((status) => sql`(${status})`),
    sql.raw(","),
  );
  const result = await db.execute<{
    from_status: (typeof CORPUS_INDEX_INTENT_STATUSES)[number];
    to_status: (typeof CORPUS_INDEX_INTENT_STATUSES)[number];
    allowed: boolean;
  }>(sql`
    WITH statuses(status) AS (VALUES ${values})
    SELECT source.status AS from_status, target.status AS to_status,
           corpus_index_projection_intent_transition_allowed(
             source.status,
             target.status
           ) AS allowed
    FROM statuses source
    CROSS JOIN statuses target
  `);

  for (const row of result.rows) {
    expect(row.allowed).toBe(
      canTransitionCorpusIndexIntent(row.from_status, row.to_status),
    );
  }
  expect(result.rows).toHaveLength(CORPUS_INDEX_INTENT_STATUSES.length ** 2);
});

test("retired generations cannot be reactivated after history becomes deletable", async () => {
  await db.execute(sql`
    INSERT INTO corpus_index_generations (
      family, generation, cluster, manifest_digest, status
    ) VALUES (
      'case_law', 'case_law_v6', 'q09', ${MANIFEST_DIGEST}, 'retiring'
    )
  `);
  await db.execute(sql`
    UPDATE corpus_index_generations
    SET status = 'retired'
    WHERE family = 'case_law' AND generation = 'case_law_v6'
  `);

  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_generations
        SET status = 'building'
        WHERE family = 'case_law' AND generation = 'case_law_v6'
      `),
    ),
  ).toContain("retired corpus index generation is terminal");
});

test("the ingestion role purges retired history only through the bounded function", async () => {
  await db.execute(sql`
    INSERT INTO case_law_decisions (
      id, source_id, case_number, court, country, language, fulltext,
      projection_epoch
    ) VALUES (
      ${RETIRED_DECISION_ID}, ${SOURCE_ID}, '1 A 3/2026', 'Test court',
      'CZE', 'cs', 'retired', 1
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_generations (
      family, generation, cluster, manifest_digest, status
    ) VALUES (
      'case_law', 'case_law_v8', 'q09', ${MANIFEST_DIGEST}, 'building'
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id
    ) VALUES (
      'case_law', 'case_law_v8', ${RETIRED_DECISION_ID}, 'upsert', 1,
      ${FIRST_FINGERPRINT}, 'case_law_v8_cs_sk'
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id,
      status, lease_token, lease_expires_at
    ) VALUES (
      ${RETIRED_REVISION}, 'case_law', 'case_law_v8',
      ${RETIRED_DECISION_ID}, 1, ${FIRST_FINGERPRINT}, 'case_law_v8_cs_sk',
      'reserved', ${LEASE_TOKEN}, clock_timestamp() + interval '5 minutes'
    )
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cancelled', cancelled_at = clock_timestamp(),
        lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${RETIRED_REVISION}
  `);
  await db.execute(sql`
    UPDATE corpus_index_generations
    SET status = 'retired'
    WHERE family = 'case_law' AND generation = 'case_law_v8'
  `);

  expect(
    await rejectionMessage(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
        await tx.execute(sql`
          DELETE FROM corpus_index_projection_states
          WHERE family = 'case_law' AND generation = 'case_law_v8'
        `);
      }),
    ),
  ).toContain("permission denied");

  const purged = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    const result = await tx.execute<{
      deleted_state_count: number;
      deleted_intent_count: number;
    }>(sql`
      SELECT * FROM purge_retired_corpus_index_projection_history(
        'case_law', 'case_law_v8', 100
      )
    `);
    await tx.execute(sql`
      DELETE FROM corpus_index_generations
      WHERE family = 'case_law' AND generation = 'case_law_v8'
    `);
    return result.rows;
  });
  expect(purged).toEqual([{ deleted_state_count: 1, deleted_intent_count: 1 }]);

  const remaining = await db.execute<{ count: number }>(sql`
    SELECT count(*)::integer AS count
    FROM corpus_index_projection_intents
    WHERE generation = 'case_law_v8'
  `);
  expect(remaining.rows).toEqual([{ count: 0 }]);
});

test("the same fenced contract owns legislation generations", async () => {
  await db.execute(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id
    ) VALUES (
      'legislation', 'legislation_v2', ${LEGISLATION_DOCUMENT_ID}, 'upsert', 1,
      ${FIRST_FINGERPRINT}, 'legislation_v2_cze'
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id,
      status, lease_token, lease_expires_at
    ) VALUES (
      ${LEGISLATION_REVISION}, 'legislation', 'legislation_v2',
      ${LEGISLATION_DOCUMENT_ID}, 1, ${FIRST_FINGERPRINT},
      'legislation_v2_cze', 'reserved', ${LEASE_TOKEN},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cancelled', cancelled_at = clock_timestamp(),
        lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${LEGISLATION_REVISION}
  `);

  const result = await db.execute<{ status: string }>(sql`
    SELECT status FROM corpus_index_projection_intents
    WHERE id = ${LEGISLATION_REVISION}
  `);
  expect(result.rows).toEqual([{ status: "cancelled" }]);
});
