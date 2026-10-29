import { panic, Result } from "better-result";
import * as v from "valibot";

import { COUNTRY_CODES } from "@stll/country-codes";
import { parseTimeZoneId, Temporal, todayFor } from "@stll/time";

import { setDedicatedStatementTimeout } from "@/api/db/dedicated-connection-timeouts";
import type { OnlineRepair } from "@/api/db/online-migration-connection";
import { INVOICE_PAYMENT_ORIGIN } from "@/api/db/schema";
import { lockInvoiceRepairBatch } from "@/api/lib/db/aggregate-lock";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { effectiveOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/**
 * Online repairs behind migration 20261029000100_invoice_payments, which gave
 * invoices a sent marker (`sent_at`) and payment records. Invoices issued
 * before it keep their meaning:
 *
 * - A sent invoice, or a paid invoice with no explicitly recorded payment,
 *   was marked sent before payment records existed, so it gets a sent marker.
 *   The exact send time was never stored; the earliest stored time known to
 *   follow the send stands in for it: when it was marked paid, else its last update. Only the marker's
 *   presence decides behaviour (a voided payment returns the invoice to sent).
 * - A paid invoice has its settlement recorded as one payment of its whole
 *   total, dated the day it was marked paid, method `other`, with no recorder
 *   (nobody entered it), so it reads nothing outstanding and voiding that
 *   payment reopens it like any other.
 *
 * Each batch commits on its own and a repaired invoice leaves the selection,
 * so an interrupted deployment resumes without replaying writes and a second
 * run changes nothing.
 */

const BATCH_SIZE = 500;
const BATCH_STATEMENT_TIMEOUT_MS = 60_000;

export const LEGACY_PAYMENT_NOTE = "Recorded before payment records existed";

// Only provenance distinguishes a legacy paid invoice from one settled by a
// recorded payment while finalized. Payment metadata is editable and cannot
// establish that distinction; a voided recorded payment still proves origin.
const LEGACY_PAID_INVOICE = `i.status = 'paid' AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id AND p.origin = '${INVOICE_PAYMENT_ORIGIN.RECORDED}')`;
const UNMARKED_SENT_PREDICATE = `i.sent_at IS NULL AND (i.status = 'sent' OR (${LEGACY_PAID_INVOICE}))`;
const UNMARKED_SENT_INVOICES = `SELECT i.id FROM public.invoices i WHERE ${UNMARKED_SENT_PREDICATE}`;

// A zero-total paid invoice owes nothing, so it needs no settling payment.
const UNSETTLED_PAID_PREDICATE = `(${LEGACY_PAID_INVOICE}) AND i.total_amount <> 0 AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id)`;
const UNSETTLED_PAID_INVOICES = `SELECT i.id FROM public.invoices i WHERE ${UNSETTLED_PAID_PREDICATE}`;

const pending = (query: string, reason: string) =>
  ({
    readCompletion: async (connection) =>
      (await connection.query(`${query} LIMIT 1`, [])).length === 0
        ? { type: "complete" }
        : { type: "incomplete", reason },
  }) satisfies Pick<OnlineRepair, "readCompletion">;

type RepairConnection = Parameters<OnlineRepair["repair"]>[0];

type LockedBackfillBatchOptions = {
  predicate: string;
  repair: (lockedIds: string) => Promise<void>;
};

/**
 * The online phase supplies a reserved physical session. Lock first, then
 * repair in a separate READ COMMITTED statement: an UPDATE's row recheck
 * alone cannot see payment rows committed after its statement snapshot.
 */
const lockedBackfillBatch = async (
  connection: RepairConnection,
  { predicate, repair }: LockedBackfillBatchOptions,
) => {
  await connection.execute("BEGIN ISOLATION LEVEL READ COMMITTED");
  const outcome = await Result.tryPromise({
    try: async () => {
      await setDedicatedStatementTimeout(
        connection.execute,
        BATCH_STATEMENT_TIMEOUT_MS,
      );
      const candidates = v.parse(
        v.array(v.object({ id: v.string() })),
        await lockInvoiceRepairBatch({
          connection,
          predicate,
          limit: BATCH_SIZE,
        }),
      );
      if (candidates.length > 0) {
        await repair(candidates.map(({ id }) => id).join(","));
      }
      await connection.execute("COMMIT");
      // Candidates invalidated while waiting on their locks still require a
      // fresh pending read, even when this batch changed nothing.
      return candidates;
    },
    catch: (cause: unknown) => cause,
  });
  if (outcome.isOk()) {
    return outcome.value;
  }
  await connection.execute("ROLLBACK");
  return abortTransaction(outcome.error);
};

/** Repeats bounded, separately committed batches until no candidate remains. */
const untilEmpty = async (
  batch: () => ReturnType<typeof lockedBackfillBatch>,
) => {
  for (;;) {
    const rows = await batch();
    if (rows.length === 0) {
      return { type: "complete" } as const;
    }
  }
};

export const INVOICE_SENT_AT_BACKFILL = {
  name: "invoice-sent-at",
  ...pending(UNMARKED_SENT_INVOICES, "Sent invoices lack their sent marker"),
  repair: async (connection) =>
    await untilEmpty(
      async () =>
        await lockedBackfillBatch(connection, {
          predicate: UNMARKED_SENT_PREDICATE,
          repair: async (lockedIds) => {
            await connection.query(
              `UPDATE public.invoices i SET sent_at = LEAST(COALESCE(i.paid_at, i.updated_at), i.updated_at)
             WHERE i.id = ANY(string_to_array($1, ',')::uuid[])
               AND ${UNMARKED_SENT_PREDICATE}
             RETURNING i.id`,
              [lockedIds],
            );
          },
        }),
    ),
} satisfies OnlineRepair;

// The raw online connection returns unknown rows; validate the stored inputs
// before deriving their day with the same source and Temporal helper as exports.
const legacyDateInputs = v.array(
  v.object({
    id: v.string(),
    settled_at: v.string(),
    time_zone: v.nullable(v.string()),
    practice_jurisdictions: v.array(
      v.object({
        countryCode: v.picklist(COUNTRY_CODES),
        isPrimary: v.boolean(),
      }),
    ),
  }),
);

const legacyPaymentBatch = async (
  connection: RepairConnection,
  lockedIds: string,
) => {
  const inputs = v.parse(
    legacyDateInputs,
    await connection.query(
      `SELECT i.id, to_char(COALESCE(i.paid_at, i.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
       s.time_zone, COALESCE(s.practice_jurisdictions, '[]'::jsonb) AS practice_jurisdictions
     FROM public.invoices i
     LEFT JOIN public.organization_settings s ON s.organization_id = i.organization_id
     WHERE i.id = ANY(string_to_array($1, ',')::uuid[])
       AND ${UNSETTLED_PAID_PREDICATE}`,
      [lockedIds],
    ),
  );
  if (inputs.length === 0) {
    return;
  }
  const dates = inputs.map((row) => {
    const timeZone =
      row.time_zone === null
        ? null
        : (parseTimeZoneId(row.time_zone) ??
          panic("Unknown stored organization time zone"));
    const instant = Temporal.Instant.from(row.settled_at);
    return {
      id: row.id,
      settled_at: instant.toString(),
      paid_on: todayFor(
        effectiveOrganizationTimeZone({
          timeZone,
          practiceJurisdictions: row.practice_jurisdictions,
        }),
        instant,
      ).toString(),
    };
  });
  // The shared batch owns these invoice locks; the predicate and timestamp
  // are checked again where the settling payments are written.
  await connection.query(
    `WITH dates AS (
       SELECT * FROM jsonb_to_recordset($1::text::jsonb)
       AS d(id uuid, settled_at timestamptz, paid_on date)
     ), claimed AS (
       UPDATE public.invoices i SET paid_at = i.paid_at
       FROM dates d
       WHERE i.id = d.id AND ${UNSETTLED_PAID_PREDICATE}
         AND COALESCE(i.paid_at, i.updated_at) = d.settled_at
       RETURNING i.id, i.organization_id, i.total_amount, i.paid_at, i.updated_at, d.paid_on
     )
     INSERT INTO public.invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, origin, note, recorded_by, created_at)
     SELECT gen_random_uuid(), c.organization_id, c.id, abs(c.total_amount),
       c.paid_on, 'other', '${INVOICE_PAYMENT_ORIGIN.LEGACY}', '${LEGACY_PAYMENT_NOTE}', NULL, COALESCE(c.paid_at, c.updated_at)
     FROM claimed c RETURNING invoice_id AS id`,
    [JSON.stringify(dates)],
  );
};

export const INVOICE_LEGACY_PAYMENT_BACKFILL = {
  name: "invoice-legacy-payments",
  ...pending(
    UNSETTLED_PAID_INVOICES,
    "Paid invoices lack their settling payment",
  ),
  repair: async (connection) =>
    await untilEmpty(
      async () =>
        await lockedBackfillBatch(connection, {
          predicate: UNSETTLED_PAID_PREDICATE,
          repair: async (lockedIds) => {
            await legacyPaymentBatch(connection, lockedIds);
          },
        }),
    ),
} satisfies OnlineRepair;
