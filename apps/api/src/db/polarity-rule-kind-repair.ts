/**
 * Online repair behind migration 20261030213329_case_law_polarity_kind_evidence,
 * which gave polarity rules a `kind` defaulting to `stance`. Each registered
 * seed rule (`SEED_RULES`) stored before then takes its typed kind here; a
 * citation-form rule also takes the neutral polarity its kind requires, in
 * the same statement, so `polarity_rules_form_neutral` holds throughout.
 * Unregistered manual and model rules keep `stance`.
 *
 * Self-checkpointing: a corrected rule leaves the selection, so an interrupted
 * run resumes by running again and a completed run finds nothing.
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { POLARITY_RULE_KIND } from "@/api/handlers/case-law/polarity/consts";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";

import { createBackfillRuntime } from "./backfill-runtime";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const POLARITY_RULE_KIND_REPAIR_NAME = "polarity-rule-kind";
const TABLE_NAME = "case_law_polarity_rules";

/** Rules per transaction; the registry is small and the runtime sizes later batches. */
const BATCH = 500;

/** `$1` is the seed registry as JSON (`SEED_KINDS_JSON`). */
const SEED_KINDS_JSON = JSON.stringify(
  SEED_RULES.map(({ language, pattern, kind }) => ({
    language,
    pattern,
    kind,
  })),
);

const SEEDS = `jsonb_to_recordset($1::text::jsonb) AS seeds(language text, pattern text, kind text)`;
const PENDING_SEEDS = `jsonb_to_recordset($1::text::jsonb) AS pending_seeds(language text, pattern text, kind text)`;

type Query = Pick<OnlineMigrationConnection, "query">;

/**
 * One bounded batch over `relation`. The relation is a parameter only so a
 * Postgres suite can run the same statement against a cloned table.
 */
export const polarityRuleKindBatchSql = (
  relation: string,
) => `UPDATE ${relation} AS rules
    SET kind = seeds.kind,
        polarity = CASE WHEN seeds.kind = '${POLARITY_RULE_KIND.FORM}' THEN 'neutral' ELSE rules.polarity END
   FROM ${SEEDS}
  WHERE rules.language = seeds.language AND rules.pattern = seeds.pattern
    AND rules.kind IS DISTINCT FROM seeds.kind
    AND rules.id IN (
      SELECT pending.id FROM ${relation} AS pending
        JOIN ${PENDING_SEEDS}
          ON pending.language = pending_seeds.language
         AND pending.pattern = pending_seeds.pattern
       WHERE pending.kind IS DISTINCT FROM pending_seeds.kind
       ORDER BY pending.id
       LIMIT $2
    )
  RETURNING rules.id`;

const correctRuleKindBatch = async (tx: Query, size: number): Promise<number> =>
  (
    await tx.query(polarityRuleKindBatchSql(`public."${TABLE_NAME}"`), [
      SEED_KINDS_JSON,
      size,
    ])
  ).length;

const hasMisclassifiedRule = async (connection: Query): Promise<boolean> =>
  (
    await connection.query(
      `SELECT 1 FROM public."${TABLE_NAME}" AS rules, ${SEEDS}
        WHERE rules.language = seeds.language AND rules.pattern = seeds.pattern
          AND rules.kind IS DISTINCT FROM seeds.kind
        LIMIT 1`,
      [SEED_KINDS_JSON],
    )
  ).length > 0;

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  if (!(await hasMisclassifiedRule(connection))) {
    return { type: "complete" };
  }
  const reason = "registered polarity rules still carry the default kind";
  const checkpoint = await connection.query(
    "SELECT 1 FROM public.database_backfill_states WHERE name = $1",
    [POLARITY_RULE_KIND_REPAIR_NAME],
  );
  return checkpoint.length === 0
    ? { type: "incomplete", reason }
    : {
        type: "pending",
        reason,
        cursor: null,
        holdUntil: null,
        heldSince: null,
      };
};

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

const correctUntilEmpty = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    introducedBy: "20261030213329_case_law_polarity_kind_evidence",
    name: POLARITY_RULE_KIND_REPAIR_NAME,
    tableName: TABLE_NAME,
    initialSize: BATCH,
    config: defaultConfig,
    connection,
    readVerdict,
    clock,
    log,
  });
  try {
    return await runBackfillPass({
      holdPolicy: "propagate",
      sleep,
      step: async () =>
        await runtime.step(async ({ tx, size, cursor }) => {
          const corrected = await correctRuleKindBatch(tx, size);
          return { cursor, done: corrected === 0, value: corrected };
        }),
    });
  } finally {
    await runtime.close();
  }
};

const createPolarityRuleKindRepair = (
  options: RepairRuntimeOptions = {},
): OnlineRepair => ({
  introducedBy: "20261030213329_case_law_polarity_kind_evidence",
  name: POLARITY_RULE_KIND_REPAIR_NAME,
  readCompletion,
  repair: async (connection) => {
    // Fresh databases and repaired ones have no data work or metric source.
    if (!(await hasMisclassifiedRule(connection))) {
      return { type: "complete" };
    }
    const pass = await correctUntilEmpty(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    return { type: "complete" };
  },
});

export const POLARITY_RULE_KIND_REPAIR = createPolarityRuleKindRepair();
