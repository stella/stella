import { panic } from "better-result";

/**
 * Online repair behind migration 20261031213747_contact_vat_id_check, which
 * adds `contacts_vat_id_check` NOT VALID: an EU VAT number lives in vat_id,
 * and tax_id holds one only beside a vat_id. A contact written before
 * 20261019010000_invoice_party_tax_vat_ids gave contacts a vat_id may hold an
 * EU VAT number in tax_id; this moves each such value to vat_id and clears
 * tax_id, by the rule invoicing reads through and every writer stores with
 * (`contactTaxIdentifiers`, as SQL `EU_VAT_ID_SQL_PATTERN`), and then
 * validates the constraint.
 *
 * Contacts force row security on their owner, which reaches one
 * organization's contacts at a time: each step names the organization in its
 * own statement before it moves that organization's batch, and the cursor
 * names the organization a pass resumes at.
 *
 * Self-checkpointing: a moved contact leaves the selection, so an interrupted
 * run resumes by running again. The NOT VALID constraint already refuses a
 * new movable value, so a completed pass leaves nothing for validation to
 * find. Completion is the catalog fact `pg_constraint.convalidated`; a
 * committed checkpoint admits a pending repair through deploy and startup.
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "@/api/lib/type-guards";

import { createBackfillRuntime } from "./backfill-runtime";
import {
  EU_VAT_ID_SQL_COMPACT,
  EU_VAT_ID_SQL_PATTERN,
} from "./eu-vat-id-format";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation, OnlineTableGate } from "./online-ddl";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
} from "./online-migration-connection";

const CONTACT_VAT_ID_REPAIR_NAME = "contact-vat-id";
const TABLE_NAME = "contacts";
const CONSTRAINT_NAME = "contacts_vat_id_check";

export const CONTACT_VAT_ID_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

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
 * row security on its owner and admits the organization the transaction
 * names. The setting is its own statement, so it holds before the next
 * statement plans its row policy.
 */
const SCOPE_ORGANIZATION = "SELECT set_config('app.organization_id', $1, true)";

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
          // A step moves one batch of the first organization from the cursor
          // that still holds a movable contact, or walks one page of them.
          const page = await organizationIds(tx, cursor, ORGANIZATION_PAGE + 1);
          for (const organizationId of page.slice(0, ORGANIZATION_PAGE)) {
            await tx.query(SCOPE_ORGANIZATION, [organizationId]);
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

/**
 * VALIDATE takes SHARE UPDATE EXCLUSIVE; the gate watches that wait and
 * defers the phase rather than failing it.
 */
const validateConstraint = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
): Promise<OnlineMigrationOutcome> =>
  await validateOnlineConstraints({
    connection,
    tables,
    constraints: CONTACT_VAT_ID_CONSTRAINTS,
  });

export const createContactVatIdRepair = (
  options: RepairRuntimeOptions = {},
): MigrationOwnedOnlineRepair => ({
  introducedBy: "20261031213747_contact_vat_id_check",
  name: CONTACT_VAT_ID_REPAIR_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      constraintName: CONSTRAINT_NAME,
      repairName: CONTACT_VAT_ID_REPAIR_NAME,
      backfillName: CONTACT_VAT_ID_REPAIR_NAME,
      tableName: TABLE_NAME,
    }),
  repair: async (connection, tables) => {
    // A fresh database has no organization, so no contact to move and no
    // metric source yet.
    if ((await organizationIds(connection, null, 1)).length > 0) {
      const pass = await moveUntilEmpty(connection, options);
      if (pass.isErr()) {
        throw pass.error;
      }
    }
    return await validateConstraint(connection, tables);
  },
});

export const CONTACT_VAT_ID_REPAIR = createContactVatIdRepair();
