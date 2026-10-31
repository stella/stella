/**
 * Online repair behind migration 20261019010000_invoice_party_tax_vat_ids,
 * which gave contacts a vat_id beside tax_id. A contact written before then
 * may hold an EU VAT number in tax_id; this moves each such value to vat_id
 * and clears tax_id, by the rule invoicing reads through and every writer
 * stores with (`contactTaxIdentifiers`, as SQL `EU_VAT_ID_SQL_PATTERN`).
 *
 * Self-checkpointing: a moved contact leaves the selection, so an interrupted
 * run resumes by running again and a completed run finds nothing. Completion
 * is the absence of a movable contact. Once a pass has recorded its
 * checkpoint, a movable contact found later reports the repair pending, so it
 * never blocks a deploy, and the next repair phase moves it.
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import {
  EU_VAT_ID_SQL_COMPACT,
  EU_VAT_ID_SQL_PATTERN,
} from "@/api/lib/billing/invoice-prefill.logic";

import { createBackfillRuntime } from "./backfill-runtime";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const CONTACT_VAT_ID_REPAIR_NAME = "contact-vat-id";
const TABLE_NAME = "contacts";

/**
 * Contacts per transaction; the runtime sizes later batches and applies its
 * own lock and statement budgets to each one.
 */
const BATCH = 500;

/** `$1` is `EU_VAT_ID_SQL_PATTERN`. */
const MOVABLE = `vat_id IS NULL AND tax_id IS NOT NULL AND ${EU_VAT_ID_SQL_COMPACT("tax_id")} ~ $1`;

type Query = Pick<OnlineMigrationConnection, "query">;

/**
 * Moves up to `size` contacts and returns how many moved. The outer predicate
 * repeats the selection: a contact a user edits concurrently is re-checked on
 * its new version after the row lock, so a VAT ID set meanwhile is kept.
 */
const moveContactVatIdBatch = async (
  tx: Query,
  size: number,
): Promise<number> =>
  (
    await tx.query(
      `UPDATE public."${TABLE_NAME}" SET vat_id = tax_id, tax_id = NULL
        WHERE ${MOVABLE}
          AND id IN (
            SELECT id FROM public."${TABLE_NAME}"
             WHERE ${MOVABLE}
             ORDER BY id
             LIMIT $2
          )
        RETURNING id`,
      [EU_VAT_ID_SQL_PATTERN, size],
    )
  ).length;

const hasMovableContact = async (connection: Query): Promise<boolean> =>
  (
    await connection.query(
      `SELECT 1 FROM public."${TABLE_NAME}" WHERE ${MOVABLE} LIMIT 1`,
      [EU_VAT_ID_SQL_PATTERN],
    )
  ).length > 0;

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  if (!(await hasMovableContact(connection))) {
    return { type: "complete" };
  }
  const reason = "contacts still hold an EU VAT number in tax_id";
  const checkpoint = await connection.query(
    "SELECT 1 FROM public.database_backfill_states WHERE name = $1",
    [CONTACT_VAT_ID_REPAIR_NAME],
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

const moveUntilEmpty = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    name: CONTACT_VAT_ID_REPAIR_NAME,
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
          const moved = await moveContactVatIdBatch(tx, size);
          return { cursor, done: moved === 0, value: moved };
        }),
    });
  } finally {
    await runtime.close();
  }
};

export const createContactVatIdRepair = (
  options: RepairRuntimeOptions = {},
): MigrationOwnedOnlineRepair => ({
  introducedBy: "20261019010000_invoice_party_tax_vat_ids",
  name: CONTACT_VAT_ID_REPAIR_NAME,
  readCompletion,
  repair: async (connection) => {
    // Fresh databases and repaired ones have no data work or metric source.
    if (!(await hasMovableContact(connection))) {
      return { type: "complete" };
    }
    const pass = await moveUntilEmpty(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    return { type: "complete" };
  },
});

export const CONTACT_VAT_ID_REPAIR = createContactVatIdRepair();
