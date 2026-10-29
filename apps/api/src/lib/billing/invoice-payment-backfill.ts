import { panic } from "better-result";
import * as v from "valibot";

import { COUNTRY_CODES } from "@stll/country-codes";
import { parseTimeZoneId, Temporal, todayFor } from "@stll/time";

import type { OnlineRepair } from "@/api/db/online-migration-connection";
import { effectiveOrganizationTimeZone } from "@/api/lib/organization-time-zone";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Online repairs behind migration 20261029000100_invoice_payments, which gave
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

const returnedIds = (rows: readonly unknown[], repair: string) => {
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
  batch: string | (() => Promise<readonly unknown[]>),
) => {
  await connection.execute("SET statement_timeout = '60s'");
  try {
    for (;;) {
      const rows =
        typeof batch === "string"
          ? await connection.query(batch, [BATCH_SIZE])
          : await batch();
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
  connection: Parameters<OnlineRepair["repair"]>[0],
) => {
  const inputs = v.parse(
    legacyDateInputs,
    await connection.query(
      `SELECT i.id, to_char(COALESCE(i.paid_at, i.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
       s.time_zone, COALESCE(s.practice_jurisdictions, '[]'::jsonb) AS practice_jurisdictions
     FROM public.invoices i
     LEFT JOIN public.organization_settings s ON s.organization_id = i.organization_id
     WHERE i.id IN (${UNSETTLED_PAID_INVOICES} ORDER BY i.id LIMIT $1)`,
      [BATCH_SIZE],
    ),
  );
  if (inputs.length === 0) {
    return [];
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
  // The claim retains the invoice lock through the insert and rechecks status,
  // absence of payments and the timestamp used to derive the day. A concurrent
  // change invalidates this input; the next batch reads its current value.
  await connection.query(
    `WITH dates AS (
       SELECT * FROM jsonb_to_recordset($1::text::jsonb)
       AS d(id uuid, settled_at timestamptz, paid_on date)
     ), claimed AS (
       UPDATE public.invoices i SET paid_at = i.paid_at
       FROM dates d
       WHERE i.id = d.id AND i.status = 'paid' AND i.total_amount <> 0
         AND COALESCE(i.paid_at, i.updated_at) = d.settled_at
         AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id)
       RETURNING i.id, i.organization_id, i.total_amount, i.paid_at, i.updated_at, d.paid_on
     )
     INSERT INTO public.invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, note, recorded_by, created_at)
     SELECT gen_random_uuid(), c.organization_id, c.id, abs(c.total_amount),
       c.paid_on, 'other', '${LEGACY_PAYMENT_NOTE}', NULL, COALESCE(c.paid_at, c.updated_at)
     FROM claimed c RETURNING invoice_id AS id`,
    [JSON.stringify(dates)],
  );
  // Even if every candidate changed while it was claimed, reread the pending
  // predicate rather than declaring the repair complete from an empty insert.
  return inputs;
};

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
      async () => await legacyPaymentBatch(connection),
    ),
} satisfies OnlineRepair;
