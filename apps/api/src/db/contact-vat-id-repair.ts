import { panic } from "better-result";

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
import { isRecord } from "@/api/lib/type-guards";

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
 * Organizations a step walks before it yields; a step resumes at the
 * organization its cursor names.
 */
const ORGANIZATION_PAGE = 100;

/**
 * The owner reaches one organization's contacts at a time: `contacts` forces
 * row security on its owner and admits the organization the session names.
 * The setting is its own statement, so it holds before the next statement
 * plans its row policy.
 */
const SCOPE_ORGANIZATION = "SELECT set_config('app.organization_id', $1, $2)";

/**
 * Moves up to `size` contacts of the scoped organization and returns how many
 * moved. The outer predicate repeats the selection: a contact a user edits
 * concurrently is re-checked on its new version after the row lock, so a VAT
 * ID set meanwhile is kept.
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

/** Up to `limit` organization ids from `from` (inclusive), in id order. */
const organizationIds = async (
  connection: Query,
  from: string | null,
  limit: number,
): Promise<string[]> =>
  (from === null
    ? await connection.query(
        "SELECT id::text AS organization_id FROM public.organization ORDER BY id LIMIT $1",
        [limit],
      )
    : await connection.query(
        "SELECT id::text AS organization_id FROM public.organization WHERE id >= $1 ORDER BY id LIMIT $2",
        [from, limit],
      )
  ).map((row) =>
    isRecord(row) && typeof row["organization_id"] === "string"
      ? row["organization_id"]
      : panic("Organization enumeration returned an invalid identifier"),
  );

/**
 * Whether any organization still holds a movable contact. The probe runs on
 * the migration session outside a transaction, so it names each organization
 * for the session and clears the setting before it returns.
 */
const hasMovableContact = async (
  connection: OnlineMigrationConnection,
): Promise<boolean> => {
  try {
    let from: string | null = null;
    for (;;) {
      const page = await organizationIds(
        connection,
        from,
        ORGANIZATION_PAGE + 1,
      );
      for (const organizationId of page.slice(0, ORGANIZATION_PAGE)) {
        await connection.query(SCOPE_ORGANIZATION, [organizationId, false]);
        const movable = await connection.query(
          `SELECT 1 FROM public."${TABLE_NAME}" WHERE ${MOVABLE} LIMIT 1`,
          [EU_VAT_ID_SQL_PATTERN],
        );
        if (movable.length > 0) {
          return true;
        }
      }
      const next = page.at(ORGANIZATION_PAGE);
      if (next === undefined) {
        return false;
      }
      from = next;
    }
  } finally {
    await connection.query(SCOPE_ORGANIZATION, ["", false]);
  }
};

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
          // The cursor names the organization the pass resumes at; a step
          // moves one batch of the first organization from there that still
          // holds a movable contact, or walks one page of organizations.
          const page = await organizationIds(tx, cursor, ORGANIZATION_PAGE + 1);
          for (const organizationId of page.slice(0, ORGANIZATION_PAGE)) {
            await tx.query(SCOPE_ORGANIZATION, [organizationId, true]);
            const moved = await moveContactVatIdBatch(tx, size);
            if (moved > 0) {
              return { cursor: organizationId, done: false, value: moved };
            }
          }
          const next = page.at(ORGANIZATION_PAGE);
          return next === undefined
            ? { cursor: null, done: true, value: 0 }
            : { cursor: next, done: false, value: 0 };
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
    const completion = await readCompletion(connection);
    if (completion.type !== "complete") {
      return panic("Contact VAT ID repair left movable contacts behind");
    }
    return completion;
  },
});

export const CONTACT_VAT_ID_REPAIR = createContactVatIdRepair();
