/** Online generation-key cutover for terminal case-law replay receipts. */
import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import {
  addNotNullCheckNotValid,
  createIndexConcurrently,
  finalizeNotNullPrimaryKey,
  reindexIndexConcurrently,
  validateOnlineConstraints,
  type GatedTableSession,
  type OnlineIndexDeclaration,
  type OnlineTableGate,
} from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";
import { CASE_LAW_RAW_GENERATION_UNKNOWN } from "./schema/case-law-replay";

const REPAIR_NAME = "case-law-replay-receipt-source-hash";
const TABLE_NAME = "case_law_replay_blocked";
const CHECK_NAME = "case_law_replay_blocked_source_hash_not_null";
const PRIMARY_KEY_NAME = "case_law_replay_blocked_pkey";
export const CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE = 1000;

export const CASE_LAW_REPLAY_RECEIPT_GENERATION_INDEX = {
  createSql:
    'CREATE UNIQUE INDEX CONCURRENTLY "case_law_replay_blocked_generation_key" ON public."case_law_replay_blocked" ("decision_id", "source_hash", "parser_version_to")',
  definitionBody:
    "ON public.case_law_replay_blocked USING btree (decision_id, source_hash, parser_version_to)",
  isUnique: true,
  name: "case_law_replay_blocked_generation_key",
  tableName: TABLE_NAME,
} as const satisfies OnlineIndexDeclaration;

type ReceiptCursor = { decisionId: string; parserVersionTo: number };
const decodeCursor = (cursor: string | null): ReceiptCursor | null => {
  if (cursor === null) {
    return null;
  }
  const value: unknown = JSON.parse(cursor);
  if (
    !isRecord(value) ||
    typeof value["decisionId"] !== "string" ||
    typeof value["parserVersionTo"] !== "number"
  ) {
    return panic(`Online repair ${REPAIR_NAME}: invalid cursor`);
  }
  return {
    decisionId: value["decisionId"],
    parserVersionTo: value["parserVersionTo"],
  };
};

export const repairCaseLawReplayReceiptBatch = async (
  connection: Pick<OnlineMigrationConnection, "execute" | "query">,
  cursor: string | null,
  size: number,
): Promise<{ cursor: string; done: boolean }> => {
  const decoded = decodeCursor(cursor);
  const rows = await connection.query(
    `SELECT decision_id AS "decisionId", parser_version_to AS "parserVersionTo"
     FROM public."${TABLE_NAME}"
     WHERE ($1::uuid IS NULL OR (decision_id, parser_version_to) > ($1::uuid, $2::int))
     ORDER BY decision_id, parser_version_to LIMIT $3`,
    [decoded?.decisionId ?? null, decoded?.parserVersionTo ?? 0, size],
  );
  const last = rows.at(-1);
  if (last === undefined) {
    return { cursor: cursor ?? "", done: true };
  }
  if (
    !isRecord(last) ||
    typeof last["decisionId"] !== "string" ||
    typeof last["parserVersionTo"] !== "number"
  ) {
    return panic(
      `Online repair ${REPAIR_NAME}: batch boundary has an invalid shape`,
    );
  }
  const next = {
    decisionId: last["decisionId"],
    parserVersionTo: last["parserVersionTo"],
  };
  await connection.execute(
    `UPDATE public."${TABLE_NAME}" blocked
     SET source_hash = COALESCE((SELECT decision.source_hash FROM public.case_law_decisions decision WHERE decision.id = blocked.decision_id), $4)
     WHERE blocked.source_hash IS NULL
       AND ($1::uuid IS NULL OR (blocked.decision_id, blocked.parser_version_to) > ($1::uuid, $2::int))
       AND (blocked.decision_id, blocked.parser_version_to) <= ($3::uuid, $5::int)`,
    [
      decoded?.decisionId ?? null,
      decoded?.parserVersionTo ?? 0,
      next.decisionId,
      CASE_LAW_RAW_GENERATION_UNKNOWN,
      next.parserVersionTo,
    ],
  );
  return { cursor: JSON.stringify(next), done: rows.length < size };
};

type RepairOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
};

const backfill = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep }: RepairOptions,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: TABLE_NAME,
    initialSize: CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
    config: defaultConfig,
    connection,
    readVerdict,
  });
  try {
    return await runBackfillPass({
      holdPolicy: "propagate",
      sleep,
      step: async () =>
        await runtime.step(async ({ tx, cursor, size }) => ({
          ...(await repairCaseLawReplayReceiptBatch(tx, cursor, size)),
          value: null,
        })),
    });
  } finally {
    await runtime.close();
  }
};

const readCompletion = async (connection: OnlineMigrationConnection) => {
  const row = (
    await connection.query(
      `SELECT array_agg(a.attname ORDER BY k.ordinality) AS columns
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'public.case_law_replay_blocked'::regclass
         AND c.conname = $1 AND c.contype = 'p' GROUP BY c.oid`,
      [PRIMARY_KEY_NAME],
    )
  ).at(0);
  if (
    isRecord(row) &&
    Array.isArray(row["columns"]) &&
    row["columns"].join(",") === "decision_id,source_hash,parser_version_to"
  ) {
    return { type: "complete" } as const;
  }
  return {
    type: "incomplete",
    reason: "generation-aware primary key is missing",
  } as const;
};

const runCatalogStep = async (
  tables: OnlineTableGate,
  name: string,
  work: (session: GatedTableSession) => Promise<void>,
) =>
  await tables.run({
    target: { tableName: TABLE_NAME, name },
    kind: "index_build",
    work,
  });

export const finishCaseLawReplayReceiptRepair = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
) => {
  const existingCheck = await connection.query(
    "SELECT 1 FROM pg_constraint WHERE conrelid = 'public.case_law_replay_blocked'::regclass AND conname = $1",
    [CHECK_NAME],
  );
  if (existingCheck.length === 0) {
    const added = await runCatalogStep(tables, CHECK_NAME, async (session) => {
      await session.run(
        addNotNullCheckNotValid({
          tableName: TABLE_NAME,
          constraintName: CHECK_NAME,
          columnName: "source_hash",
        }),
      );
    });
    if (added.type === "deferred") {
      return added;
    }
  }
  const validated = await validateOnlineConstraints({
    connection,
    tables,
    constraints: [{ tableName: TABLE_NAME, constraintName: CHECK_NAME }],
  });
  if (validated.type === "deferred") {
    return validated;
  }

  const indexState = (
    await connection.query(
      `SELECT i.indisvalid AS "isValid" FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [CASE_LAW_REPLAY_RECEIPT_GENERATION_INDEX.name],
    )
  ).at(0);
  if (!isRecord(indexState) || indexState["isValid"] !== true) {
    const index = await runCatalogStep(
      tables,
      CASE_LAW_REPLAY_RECEIPT_GENERATION_INDEX.name,
      async (session) =>
        await session.run(
          indexState === undefined
            ? createIndexConcurrently(CASE_LAW_REPLAY_RECEIPT_GENERATION_INDEX)
            : reindexIndexConcurrently(
                CASE_LAW_REPLAY_RECEIPT_GENERATION_INDEX,
              ),
        ),
    );
    if (index.type === "deferred") {
      return index;
    }
  }

  // The old key remains authoritative until this short swap, so deployments
  // between column creation and repair completion cannot store two raw
  // generations for the same decision and parser version.
  return await runCatalogStep(tables, PRIMARY_KEY_NAME, async (session) => {
    await session.run(
      finalizeNotNullPrimaryKey({
        tableName: TABLE_NAME,
        columnName: "source_hash",
        checkName: CHECK_NAME,
        primaryKeyName: PRIMARY_KEY_NAME,
        indexName: CASE_LAW_REPLAY_RECEIPT_GENERATION_INDEX.name,
      }),
    );
  });
};

export const createCaseLawReplayReceiptRepair = (
  options: RepairOptions = {},
): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion,
  repair: async (connection, tables) => {
    const pass = await backfill(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    return await finishCaseLawReplayReceiptRepair(connection, tables);
  },
});

export const CASE_LAW_REPLAY_RECEIPT_REPAIR =
  createCaseLawReplayReceiptRepair();
