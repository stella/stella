import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  caseLawCorpusUploadIntents,
  caseLawDecisions,
  caseLawSearchDocuments,
  schedulerJobs,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  REDACTION_TOMBSTONE_BACKFILL_JOB_ID,
} from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

export type RedactionTombstoneScenario = {
  type: "redaction-tombstones";
  rows: number;
  cohort: "repair" | "inline-raw" | "settled";
};

const SOURCE_ID = toSafeId<"caseLawSource">(
  "01890000-00d3-7000-8000-000000000000",
);
const PAGE_END = toSafeId<"caseLawDecision">(
  "01890000-00d4-7000-8000-000000000100",
);
const CONTROL_ID = toSafeId<"caseLawDecision">(
  "01890000-00d5-7000-8000-000000000001",
);
const CONSTRAINT = "case_law_decisions_redacted_payload_erased";
const LEASE = "query-perf-redaction";

/** Restore historical rows only in the disposable measurement database. */
export const seedRedactionTombstoneScenario = async (
  database: GatedTestDb,
  { rows, cohort }: RedactionTombstoneScenario,
) => {
  await database.execute(
    sql`DELETE FROM scheduler_jobs WHERE id LIKE 'query-perf-redaction-background:%'`,
  );
  await database.execute(sql`DELETE FROM case_law_corpus_upload_intents WHERE decision_id IN
    (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID})`);
  await database.execute(
    sql`DELETE FROM case_law_sources WHERE id = ${SOURCE_ID}`,
  );
  const definition = v
    .parse(
      v.object({ definition: v.string() }),
      executedRows(
        await database.execute(sql`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'case_law_decisions'::regclass AND conname = ${CONSTRAINT}`),
      ).at(0),
    )
    .definition.replace(/ NOT VALID$/u, "");
  await database.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE case_law_decisions DISABLE TRIGGER USER`);
    await tx.execute(sql`ALTER TABLE case_law_index_jobs DISABLE TRIGGER USER`);
    await tx.execute(
      sql`ALTER TABLE case_law_search_documents DISABLE TRIGGER USER`,
    );
    await tx.execute(
      sql`ALTER TABLE case_law_corpus_upload_intents DISABLE TRIGGER USER`,
    );
    await tx.execute(
      sql`ALTER TABLE case_law_decisions DROP CONSTRAINT case_law_decisions_redacted_payload_erased`,
    );
    await tx.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name, enabled)
      VALUES (${SOURCE_ID}, 'query-perf-redaction', 'Redaction measurement', false)`);
    await tx.execute(sql`INSERT INTO case_law_decisions
      (id, source_id, case_number, country, court, language, fulltext, source_raw,
       text_s3_key, normalized_s3_key, ast_s3_key, redacted_at)
      SELECT ('01890000-00d4-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ${SOURCE_ID}::uuid, 'Measurement ' || n, 'CZE', 'Measurement court', 'cs',
        CASE WHEN n <= 100 AND ${cohort} = 'repair' THEN 'Rozhodnutí o náhradě nákladů.' ELSE NULL END,
        CASE WHEN n <= 100 AND ${cohort} <> 'settled' THEN
          (SELECT string_agg(md5(n::text || ':' || part::text), '') FROM generate_series(1, 128) part)
          ELSE NULL END,
        CASE WHEN n <= 100 AND ${cohort} = 'repair' THEN 'fixture/text/' || n ELSE NULL END,
        CASE WHEN n <= 100 AND ${cohort} = 'repair' THEN 'fixture/sections/' || n ELSE NULL END,
        CASE WHEN n <= 100 AND ${cohort} = 'repair' THEN 'fixture/ast/' || n ELSE NULL END,
        CASE WHEN ${cohort} = 'repair' THEN NULL ELSE '2026-01-01'::timestamptz END
      FROM generate_series(1, ${rows}::integer) n`);
    await tx.execute(sql`INSERT INTO case_law_decisions
      (id, source_id, case_number, country, court, language, fulltext, source_raw)
      VALUES (${CONTROL_ID}, ${SOURCE_ID}, 'Live control', 'CZE', 'Measurement court', 'cs', 'Live text', 'Live publisher payload')`);
    await tx.execute(sql`INSERT INTO case_law_search_documents (decision_id, searchable_text)
      SELECT id, 'Searchable fixture text' FROM case_law_decisions WHERE source_id = ${SOURCE_ID}`);
    await tx.execute(sql`INSERT INTO case_law_corpus_upload_intents
      (id, decision_id, text_s3_key, normalized_s3_key, ast_s3_key, lease_expires_at, status, next_cleanup_at)
      SELECT ('01890000-00d6-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ('01890000-00d4-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        'fixture/reserved/text/' || n, 'fixture/reserved/sections/' || n, 'fixture/reserved/ast/' || n,
        '2026-01-01'::timestamptz, CASE WHEN ${cohort} = 'repair' THEN 'active' ELSE 'cleanup' END, CASE WHEN ${cohort} = 'repair' THEN NULL ELSE '2026-01-01'::timestamptz END FROM generate_series(1, ${rows}::integer) n`);
    await tx.execute(sql`INSERT INTO case_law_index_jobs (id, decision_id, operation, status, created_at)
      SELECT ('01890000-00d7-7000-8000-' || right(id::text, 12))::uuid, id, 'redact', 'succeeded', '2026-01-01'::timestamptz
      FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <> ${CONTROL_ID}`);
    await tx.execute(sql`INSERT INTO case_law_index_jobs (id, decision_id, operation, status, created_at)
      SELECT ('01890000-00d8-7000-8000-' || right(id::text, 12))::uuid, id, 'redact', 'succeeded', '2026-01-02'::timestamptz
      FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <= ${PAGE_END}`);
    await tx.execute(
      sql`ALTER TABLE case_law_decisions ADD CONSTRAINT case_law_decisions_redacted_payload_erased ${sql.raw(definition)} NOT VALID`,
    );
    await tx.execute(
      sql`ALTER TABLE case_law_corpus_upload_intents ENABLE TRIGGER USER`,
    );
    await tx.execute(
      sql`ALTER TABLE case_law_search_documents ENABLE TRIGGER USER`,
    );
    await tx.execute(sql`ALTER TABLE case_law_index_jobs ENABLE TRIGGER USER`);
    await tx.execute(sql`ALTER TABLE case_law_decisions ENABLE TRIGGER USER`);
    await tx.execute(sql`INSERT INTO scheduler_jobs (id, task, schedule, next_run_at, enabled)
      SELECT 'query-perf-redaction-background:' || n, 'noop', '{"type":"interval","everyMs":60000}'::jsonb,
        '2026-01-10'::timestamptz, false FROM generate_series(1, ${rows}::integer) n`);
    await tx
      .insert(schedulerJobs)
      .values({
        id: REDACTION_TOMBSTONE_BACKFILL_JOB_ID,
        task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
        schedule: { type: "interval", everyMs: 60_000 },
        lockedBy: LEASE,
        lockedAt: new Date("2026-01-10T12:00:00Z"),
        nextRunAt: new Date("2026-01-10T12:00:00Z"),
        payload: { cursor: null },
      })
      .onConflictDoUpdate({
        target: schedulerJobs.id,
        set: { lockedBy: LEASE, payload: { cursor: null }, enabled: true },
      });
  });
  for (const table of [
    "case_law_decisions",
    "case_law_index_jobs",
    "case_law_search_documents",
    "case_law_corpus_upload_intents",
    "scheduler_jobs",
  ]) {
    // db-await-in-loop: fixed fixture tables need fresh statistics at each population size.
    await database.execute(sql.raw(`VACUUM (ANALYZE) ${table}`));
  }
};

/** A full page, the inline cleanup and the non-audited control must all be exercised. */
export const redactionTombstonePageCompleted = async (
  database: GatedTestDb,
) => {
  const job =
    (
      await database
        .select({ payload: schedulerJobs.payload })
        .from(schedulerJobs)
        .where(eq(schedulerJobs.id, REDACTION_TOMBSTONE_BACKFILL_JOB_ID))
    ).at(0) ?? panic("Missing measured redaction job");
  const repaired = await database.$count(
    caseLawDecisions,
    sql`${caseLawDecisions.sourceId} = ${SOURCE_ID} AND ${caseLawDecisions.id} <= ${PAGE_END} AND ${caseLawDecisions.redactedAt} = '2026-01-02'::timestamptz`,
  );
  const pointers = await database.$count(
    caseLawCorpusUploadIntents,
    sql`${caseLawCorpusUploadIntents.decisionId} <= ${PAGE_END} AND ${caseLawCorpusUploadIntents.textS3Key} LIKE 'fixture/text/%' AND ${caseLawCorpusUploadIntents.status} = 'cleanup'`,
  );
  const activeReservations = await database.$count(
    caseLawCorpusUploadIntents,
    sql`${caseLawCorpusUploadIntents.status} = 'active' AND ${caseLawCorpusUploadIntents.decisionId} IN
    (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <= ${PAGE_END})`,
  );
  return (
    activeReservations === 0 &&
    pointers === repaired &&
    job.payload?.["cursor"] === PAGE_END &&
    executedRows(
      await database.execute(sql`SELECT 1 FROM case_law_decisions
      WHERE source_id = ${SOURCE_ID} AND id <= ${PAGE_END}
        AND (redacted_at IS NULL OR source_raw IS NOT NULL OR fulltext IS NOT NULL OR text_s3_key IS NOT NULL OR normalized_s3_key IS NOT NULL OR ast_s3_key IS NOT NULL)`),
    ).length === 0 &&
    (await database.$count(
      caseLawSearchDocuments,
      sql`${caseLawSearchDocuments.decisionId} <= ${PAGE_END}`,
    )) === 0 &&
    (await database.$count(
      caseLawDecisions,
      sql`${caseLawDecisions.id} = ${CONTROL_ID} AND ${caseLawDecisions.sourceRaw} = 'Live publisher payload'`,
    )) === 1 &&
    (await database.$count(
      caseLawSearchDocuments,
      eq(caseLawSearchDocuments.decisionId, CONTROL_ID),
    )) === 1
  );
};
