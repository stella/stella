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
const COHORT_CODES = {
  repair: 0,
  "inline-raw": 1,
  settled: 2,
} as const satisfies Record<RedactionTombstoneScenario["cohort"], number>;
const CONTROL_CASE_NUMBER = "Live control";

/**
 * Each population gets decision ids of its own. A measured run leaves desired
 * projection states behind that only a retired generation may purge, so a
 * population reusing the previous one's ids would start from its states.
 */
const populationIds = ({ rows, cohort }: RedactionTombstoneScenario) => {
  const thousands = rows / 1000;
  if (!Number.isInteger(thousands) || thousands < 1 || thousands > 0xff) {
    return panic(
      "Redaction measurement rows must be whole thousands up to 255,000",
    );
  }
  const group = (0x80_00 + COHORT_CODES[cohort] * 0x1_00 + thousands)
    .toString(16)
    .padStart(4, "0");
  return {
    decisionPrefix: `01890000-00d4-7000-${group}-`,
    citationPrefix: `01890000-00d9-7000-${group}-`,
    controlId: toSafeId<"caseLawDecision">(
      `01890000-00d5-7000-${group}-000000000001`,
    ),
    pageEnd: toSafeId<"caseLawDecision">(
      `01890000-00d4-7000-${group}-000000000050`,
    ),
  };
};
const CONSTRAINT = "case_law_decisions_redacted_payload_erased";
const LEASE = "query-perf-redaction";

/** Times one seed step, so a slow reseed names the step that spends it. */
const seedStep = async <T>(step: string, operation: () => Promise<T>) => {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    process.stdout.write(
      `${JSON.stringify({
        event: "redaction_seed_step",
        step,
        ms: Math.round(performance.now() - started),
      })}\n`,
    );
  }
};

/** Restore historical rows only in the disposable measurement database. */
export const seedRedactionTombstoneScenario = async (
  database: GatedTestDb,
  scenario: RedactionTombstoneScenario,
) => {
  const { rows, cohort } = scenario;
  const { decisionPrefix, citationPrefix, controlId, pageEnd } =
    populationIds(scenario);
  await seedStep(
    "delete scheduler rows",
    async () =>
      await database.execute(
        sql`DELETE FROM scheduler_jobs WHERE id LIKE 'query-perf-redaction-background:%'`,
      ),
  );
  await seedStep(
    "delete upload intents",
    async () =>
      await database.execute(sql`DELETE FROM case_law_corpus_upload_intents WHERE decision_id IN
    (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID})`),
  );
  await seedStep(
    "delete source",
    async () =>
      await database.execute(
        sql`DELETE FROM case_law_sources WHERE id = ${SOURCE_ID}`,
      ),
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
  await seedStep(
    "insert population",
    async () =>
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE case_law_decisions DISABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_index_jobs DISABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_search_documents DISABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_corpus_upload_intents DISABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_decision_identifiers DISABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_provision_citations DISABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_decisions DROP CONSTRAINT case_law_decisions_redacted_payload_erased`,
        );
        await tx.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name, enabled)
      VALUES (${SOURCE_ID}, 'query-perf-redaction', 'Redaction measurement', false)`);
        await tx.execute(sql`INSERT INTO case_law_decisions
      (id, source_id, case_number, docket_family_key, country, court, language, fulltext, source_raw,
       text_s3_key, normalized_s3_key, ast_s3_key, redacted_at)
      SELECT (${decisionPrefix} || lpad(n::text, 12, '0'))::uuid,
        ${SOURCE_ID}::uuid, 'Measurement ' || n, NULL, 'CZE', 'Measurement court', 'cs',
        CASE WHEN n <= 50 AND ${cohort} = 'repair' THEN 'Rozhodnutí o náhradě nákladů.' ELSE NULL END,
        CASE WHEN n <= 50 AND ${cohort} <> 'settled' THEN
          (SELECT string_agg(md5(n::text || ':' || part::text), '') FROM generate_series(1, 128) part)
          ELSE NULL END,
        CASE WHEN n <= 50 AND ${cohort} = 'repair' THEN 'fixture/text/' || n ELSE NULL END,
        CASE WHEN n <= 50 AND ${cohort} = 'repair' THEN 'fixture/sections/' || n ELSE NULL END,
        CASE WHEN n <= 50 AND ${cohort} = 'repair' THEN 'fixture/ast/' || n ELSE NULL END,
        CASE WHEN ${cohort} = 'repair' THEN NULL ELSE '2026-01-01'::timestamptz END
      FROM generate_series(1, ${rows}::integer) n`);
        await tx.execute(sql`INSERT INTO case_law_decisions
      (id, source_id, case_number, docket_family_key, country, court, language, fulltext, source_raw)
      VALUES (${controlId}, ${SOURCE_ID}, ${CONTROL_CASE_NUMBER}, NULL, 'CZE', 'Measurement court', 'cs', 'Live text', 'Live publisher payload')`);
        await tx.execute(sql`INSERT INTO case_law_search_documents (decision_id, searchable_text)
      SELECT id, 'Searchable fixture text' FROM case_law_decisions WHERE source_id = ${SOURCE_ID}`);
        await tx.execute(sql`INSERT INTO case_law_corpus_upload_intents
      (id, decision_id, text_s3_key, normalized_s3_key, ast_s3_key, lease_expires_at, status, next_cleanup_at)
      SELECT ('01890000-00d6-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        (${decisionPrefix} || lpad(n::text, 12, '0'))::uuid,
        'fixture/reserved/text/' || n, 'fixture/reserved/sections/' || n, 'fixture/reserved/ast/' || n,
        '2026-01-01'::timestamptz, CASE WHEN ${cohort} = 'repair' THEN 'active' ELSE 'cleanup' END, CASE WHEN ${cohort} = 'repair' THEN NULL ELSE '2026-01-01'::timestamptz END FROM generate_series(1, ${rows}::integer) n`);
        await tx.execute(sql`INSERT INTO case_law_index_jobs (id, decision_id, operation, status, created_at)
      SELECT ('01890000-00d7-7000-8000-' || right(id::text, 12))::uuid, id, 'redact', 'succeeded', '2026-01-01'::timestamptz
      FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <> ${controlId}`);
        await tx.execute(sql`INSERT INTO case_law_index_jobs (id, decision_id, operation, status, created_at)
      SELECT ('01890000-00d8-7000-8000-' || right(id::text, 12))::uuid, id, 'redact', 'succeeded', '2026-01-02'::timestamptz
      FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <= ${pageEnd}`);
        // Every decision states an identifier and cites a provision, as
        // published decisions do: the projection reads both by decision.
        await tx.execute(sql`INSERT INTO case_law_decision_identifiers
      (decision_id, type, value, normalized_value)
      SELECT id, 'ecli', 'ECLI:CZ:QP:2026:' || id::text, 'ECLI:CZ:QP:2026:' || id::text
      FROM case_law_decisions WHERE source_id = ${SOURCE_ID}`);
        await tx.execute(sql`INSERT INTO case_law_provision_citations
      (id, decision_id, jurisdiction, work_identifier, work_number, work_year, work_collection,
       unit, section, work_eli, anchor, span_start, span_end, sentence_text, confidence)
      SELECT (${citationPrefix} || right(id::text, 12))::uuid, id, 'CZE', '89/2012 Sb.', 89, 2012, 'Sb.',
        'section', 1, '/eli/cz/sb/2012/89', 's1', 0, 5, 'Citation', 1
      FROM case_law_decisions WHERE source_id = ${SOURCE_ID}`);
        await tx.execute(
          sql`ALTER TABLE case_law_decisions ADD CONSTRAINT case_law_decisions_redacted_payload_erased ${sql.raw(definition)} NOT VALID`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_provision_citations ENABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_decision_identifiers ENABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_corpus_upload_intents ENABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_search_documents ENABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_index_jobs ENABLE TRIGGER USER`,
        );
        await tx.execute(
          sql`ALTER TABLE case_law_decisions ENABLE TRIGGER USER`,
        );
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
            lockedUntil: new Date("2026-01-10T12:05:00Z"),
            nextRunAt: new Date("2026-01-10T12:00:00Z"),
            payload: { cursor: null },
          })
          .onConflictDoUpdate({
            target: schedulerJobs.id,
            set: {
              lockedBy: LEASE,
              lockedAt: new Date("2026-01-10T12:00:00Z"),
              lockedUntil: new Date("2026-01-10T12:05:00Z"),
              payload: { cursor: null },
              enabled: true,
            },
          });
      }),
  );
  // Every population starts unprocessed: no desired state or signal change of
  // an earlier run may name its decisions.
  const leftovers = v.parse(
    v.object({ states: v.number(), signals: v.number() }),
    executedRows(
      await database.execute(sql`SELECT
        (SELECT count(*)::int FROM corpus_index_projection_states
          WHERE family = 'case_law' AND entity_id IN
            (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID})) AS states,
        (SELECT count(*)::int FROM case_law_ranking_signal_changes WHERE decision_id IN
          (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID})) AS signals`),
    ).at(0),
  );
  if (leftovers.states !== 0 || leftovers.signals !== 0) {
    panic(
      `Redaction measurement seed kept ${String(leftovers.states)} projection states and ${String(leftovers.signals)} signal changes`,
    );
  }
  for (const table of [
    "case_law_decisions",
    "case_law_index_jobs",
    "case_law_search_documents",
    "case_law_corpus_upload_intents",
    "scheduler_jobs",
  ]) {
    // db-await-in-loop: fixed fixture tables need fresh statistics at each population size.
    await seedStep(
      `vacuum ${table}`,
      async () => await database.execute(sql.raw(`VACUUM (ANALYZE) ${table}`)),
    );
  }
  // The planner reads both by decision only with their statistics current.
  await seedStep(
    "analyze case_law_decision_identifiers",
    async () =>
      await database.execute(sql`ANALYZE case_law_decision_identifiers`),
  );
  await seedStep(
    "analyze case_law_provision_citations",
    async () =>
      await database.execute(sql`ANALYZE case_law_provision_citations`),
  );
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
  // The seeded population names its own ids: the control row by its case
  // number, and the page as the first fifty audited decisions.
  const controlId =
    (
      await database
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          sql`${caseLawDecisions.sourceId} = ${SOURCE_ID} AND ${caseLawDecisions.caseNumber} = ${CONTROL_CASE_NUMBER}`,
        )
        .limit(1)
    ).at(0)?.id ?? panic("Missing redaction measurement control");
  const pageEnd =
    (
      await database
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          sql`${caseLawDecisions.sourceId} = ${SOURCE_ID} AND ${caseLawDecisions.id} <> ${controlId}`,
        )
        .orderBy(caseLawDecisions.id)
        .limit(1)
        .offset(49)
    ).at(0)?.id ?? panic("Missing redaction measurement page");
  const repaired = await database.$count(
    caseLawDecisions,
    sql`${caseLawDecisions.sourceId} = ${SOURCE_ID} AND ${caseLawDecisions.id} <= ${pageEnd} AND ${caseLawDecisions.redactedAt} = '2026-01-02'::timestamptz`,
  );
  const pointers = await database.$count(
    caseLawCorpusUploadIntents,
    sql`${caseLawCorpusUploadIntents.decisionId} <= ${pageEnd} AND ${caseLawCorpusUploadIntents.textS3Key} LIKE 'fixture/text/%' AND ${caseLawCorpusUploadIntents.status} = 'cleanup'`,
  );
  const activeReservations = await database.$count(
    caseLawCorpusUploadIntents,
    sql`${caseLawCorpusUploadIntents.status} = 'active' AND ${caseLawCorpusUploadIntents.decisionId} IN
    (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <= ${pageEnd})`,
  );
  return (
    activeReservations === 0 &&
    pointers === repaired &&
    job.payload?.["cursor"] === pageEnd &&
    executedRows(
      await database.execute(sql`SELECT 1 FROM case_law_decisions
      WHERE source_id = ${SOURCE_ID} AND id <= ${pageEnd}
        AND (redacted_at IS NULL OR source_raw IS NOT NULL OR fulltext IS NOT NULL OR text_s3_key IS NOT NULL OR normalized_s3_key IS NOT NULL OR ast_s3_key IS NOT NULL)`),
    ).length === 0 &&
    (await database.$count(
      caseLawSearchDocuments,
      sql`${caseLawSearchDocuments.decisionId} IN
      (SELECT id FROM case_law_decisions WHERE source_id = ${SOURCE_ID} AND id <= ${pageEnd})`,
    )) === 0 &&
    (await database.$count(
      caseLawDecisions,
      sql`${caseLawDecisions.id} = ${controlId} AND ${caseLawDecisions.sourceRaw} = 'Live publisher payload'`,
    )) === 1 &&
    (await database.$count(
      caseLawSearchDocuments,
      eq(caseLawSearchDocuments.decisionId, controlId),
    )) === 1
  );
};
