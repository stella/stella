import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

import { readConstraintCompletion } from "./online-constraint-completion";
import type { OnlineRepair } from "./online-migration-connection";

const CLIENT_BACKFILL_BATCH_SIZE = 500;
const PENDING_CLIENT_INVOICES = `SELECT i.id FROM public.invoices i JOIN public.workspaces w ON w.id=i.workspace_id AND w.organization_id=i.organization_id WHERE i.client_id IS NULL AND w.client_id IS NOT NULL`;

/** A committed row leaves the predicate, so interrupted deployments resume without replaying writes. */
export const CLIENT_INVOICE_BACKFILL = {
  name: "client-invoice-clients",
  readCompletion: async (connection) => {
    const pending = await connection.query(
      `${PENDING_CLIENT_INVOICES} LIMIT 1`,
      [],
    );
    return pending.length === 0
      ? { type: "complete" }
      : { type: "incomplete", reason: "Invoice client backfill is pending" };
  },
  repair: async (connection) => {
    await connection.execute("SET statement_timeout = '60s'");
    try {
      for (;;) {
        // Each statement commits separately; originals are filled before their credit notes.
        const rows = await connection.query(
          `WITH batch AS (
    ${PENDING_CLIENT_INVOICES} AND (i.original_invoice_id IS NULL OR EXISTS (SELECT 1 FROM public.invoices original WHERE original.id=i.original_invoice_id AND original.organization_id=i.organization_id AND original.client_id=w.client_id)) ORDER BY i.id LIMIT $1
   ) UPDATE public.invoices i SET client_id=w.client_id FROM public.workspaces w,batch
   WHERE i.id=batch.id AND i.workspace_id=w.id AND i.organization_id=w.organization_id AND i.client_id IS NULL
   RETURNING i.id`,
          [CLIENT_BACKFILL_BATCH_SIZE],
        );
        if (rows.length === 0) {
          return;
        }
        if (
          rows.some((row) => !isRecord(row) || typeof row["id"] !== "string")
        ) {
          panic("Invoice client backfill returned invalid rows");
        }
      }
    } finally {
      await connection.execute("SET statement_timeout = 0");
    }
  },
} satisfies OnlineRepair;

const CLIENT_INVOICE_CONSTRAINTS = [
  { tableName: "invoices", constraintName: "invoices_scope_check" },
  { tableName: "invoices", constraintName: "invoices_client_organization_fk" },
  {
    tableName: "invoices",
    constraintName: "invoices_original_organization_fk",
  },
  {
    tableName: "invoice_lines",
    constraintName: "invoice_lines_recorded_snapshot_check",
  },
] as const;

export const CLIENT_INVOICE_CONSTRAINT_VALIDATIONS =
  CLIENT_INVOICE_CONSTRAINTS.map(
    ({ tableName, constraintName }) =>
      ({
        name: constraintName,
        readCompletion: async (connection) =>
          await readConstraintCompletion({
            connection,
            tableName,
            constraintName,
            repairName: constraintName,
          }),
        repair: async (connection) => {
          await connection.execute(
            `ALTER TABLE public."${tableName}" VALIDATE CONSTRAINT "${constraintName}"`,
          );
        },
      }) satisfies OnlineRepair,
  );
