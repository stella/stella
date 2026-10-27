import { panic } from "better-result";

import type { OnlineRepair } from "@/api/db/online-migration-connection";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Online repairs behind migration 20261027210000_invoice_payments, which gave
 * invoices a sent marker (`sent_at`) and payment records. Invoices issued
 * before it keep their meaning:
 *
 * - A sent or paid invoice was marked sent (marking paid was only possible
 *   from sent), so it gets a sent marker. The exact send time was never
 *   stored; the earliest stored time known to follow the send stands in for
 *   it: when it was marked paid, else its last update. Only the marker's
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

export const LEGACY_PAYMENT_NOTE = "Recorded before payment records existed";

const UNMARKED_SENT_INVOICES = `SELECT i.id FROM public.invoices i WHERE i.status IN ('sent', 'paid') AND i.sent_at IS NULL`;

// A zero-total paid invoice owes nothing, so it needs no settling payment.
const UNSETTLED_PAID_INVOICES = `SELECT i.id FROM public.invoices i WHERE i.status = 'paid' AND i.total_amount <> 0 AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id)`;

const returnedIds = (rows: unknown[], repair: string) => {
  if (rows.some((row) => !isRecord(row) || typeof row["id"] !== "string")) {
    panic(`${repair} returned invalid rows`);
  }
  return rows.length;
};

const pending = (query: string, reason: string) =>
  ({
    readCompletion: async (connection) =>
      (await connection.query(`${query} LIMIT 1`, [])).length === 0
        ? { type: "complete" }
        : { type: "incomplete", reason },
  }) satisfies Pick<OnlineRepair, "readCompletion">;

/** Repeats `batch` until it moves no row, each statement committing alone. */
const untilEmpty = async (
  connection: Parameters<OnlineRepair["repair"]>[0],
  repair: string,
  batch: string,
) => {
  await connection.execute("SET statement_timeout = '60s'");
  try {
    for (;;) {
      const rows = await connection.query(batch, [BATCH_SIZE]);
      if (returnedIds(rows, repair) === 0) {
        return { type: "complete" } as const;
      }
    }
  } finally {
    await connection.execute("SET statement_timeout = 0");
  }
};

export const INVOICE_SENT_AT_BACKFILL = {
  name: "invoice-sent-at",
  ...pending(UNMARKED_SENT_INVOICES, "Sent invoices lack their sent marker"),
  repair: async (connection) =>
    await untilEmpty(
      connection,
      "Invoice sent marker backfill",
      // An UPDATE re-checks its own predicate on the row version it locks, so
      // an invoice voided or marked sent meanwhile is judged on that version.
      `UPDATE public.invoices i SET sent_at = LEAST(COALESCE(i.paid_at, i.updated_at), i.updated_at)
   WHERE i.id IN (${UNMARKED_SENT_INVOICES} ORDER BY i.id LIMIT $1)
     AND i.status IN ('sent', 'paid') AND i.sent_at IS NULL
   RETURNING i.id`,
    ),
} satisfies OnlineRepair;

export const INVOICE_LEGACY_PAYMENT_BACKFILL = {
  name: "invoice-legacy-payments",
  ...pending(
    UNSETTLED_PAID_INVOICES,
    "Paid invoices lack their settling payment",
  ),
  repair: async (connection) =>
    await untilEmpty(
      connection,
      "Invoice settling payment backfill",
      // The batch claims each invoice with an UPDATE that changes no value:
      // it waits for a concurrent void (which holds the invoice row) and
      // re-checks its predicate on the version it locks, so a voided or
      // already settled invoice leaves the batch before its payment is written.
      `WITH claimed AS (
     UPDATE public.invoices i SET paid_at = i.paid_at
     WHERE i.id IN (${UNSETTLED_PAID_INVOICES} ORDER BY i.id LIMIT $1)
       AND i.status = 'paid' AND i.total_amount <> 0
       AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id)
     RETURNING i.id, i.organization_id, i.total_amount, i.paid_at, i.updated_at
   )
   INSERT INTO public.invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, note, recorded_by, created_at)
   SELECT gen_random_uuid(), c.organization_id, c.id, abs(c.total_amount),
     (COALESCE(c.paid_at, c.updated_at) AT TIME ZONE 'UTC')::date, 'other',
     '${LEGACY_PAYMENT_NOTE}', NULL, COALESCE(c.paid_at, c.updated_at)
   FROM claimed c
   RETURNING invoice_id AS id`,
    ),
} satisfies OnlineRepair;
