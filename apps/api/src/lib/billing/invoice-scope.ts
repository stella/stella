import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";

type InvoiceScopeColumns = {
  id: SQLWrapper;
  workspaceId: SQLWrapper;
  clientId: SQLWrapper;
  organizationId: SQLWrapper;
};

/** RLS authorizes the complete invoice; this additionally binds the matter URL. */
// sql-perf-allow: index invoices_ws_status_idx and invoice_lines_invoice_position_idx bound the matter invoice lookup.
export const invoiceTouchesMatter = (
  table: InvoiceScopeColumns,
  workspaceId: SafeId<"workspace">,
) =>
  sql`(${table.workspaceId} = ${workspaceId} OR EXISTS (SELECT 1 FROM public.invoice_lines scope_line WHERE scope_line.invoice_id = ${table.id} AND scope_line.workspace_id = ${workspaceId}))`;

/**
 * A client invoice stays addressable through any matter of its client after
 * its last line for the URL matter is removed. A single-matter invoice is
 * addressable only through its own matter.
 */
// sql-perf-allow: bounded by one invoice ID for point operations; workspaces primary key resolves the client.
export const invoiceInMatter = (
  table: InvoiceScopeColumns,
  workspaceId: SafeId<"workspace">,
) =>
  sql`(${invoiceTouchesMatter(table, workspaceId)} OR (${table.workspaceId} IS NULL AND EXISTS (SELECT 1 FROM public.workspaces invoice_matter WHERE invoice_matter.id = ${workspaceId} AND invoice_matter.organization_id = ${table.organizationId} AND invoice_matter.client_id = ${table.clientId})))`;

/** Credential scope covers this invoice and every matter of its linked original. */
export const invoiceWithinMatterAllowlist = (
  table: Pick<InvoiceScopeColumns, "id" | "workspaceId"> & {
    originalInvoiceId: SQLWrapper;
  },
  workspaceIds: readonly SafeId<"workspace">[],
) => {
  if (workspaceIds.length === 0) {
    return sql`false`;
  }
  const allowed = sql.join(
    workspaceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`((${table.workspaceId} IS NULL OR ${table.workspaceId} IN (${allowed})) AND NOT EXISTS (SELECT 1 FROM public.invoice_lines credential_line WHERE credential_line.invoice_id IN (${table.id}, ${table.originalInvoiceId}) AND credential_line.workspace_id NOT IN (${allowed})))`;
};

type InvoiceShareColumns = {
  id: SQLWrapper;
  workspaceId: SQLWrapper;
  totalAmount: SQLWrapper;
};

/** A legacy single-matter invoice has only its stored total until lines exist. */
export const invoiceMatterShare = (
  table: InvoiceShareColumns,
  workspaceId: SafeId<"workspace">,
) =>
  sql<number>`COALESCE((SELECT SUM(share_line.gross_amount) FROM public.invoice_lines share_line WHERE share_line.invoice_id = ${table.id} AND share_line.workspace_id = ${workspaceId}), CASE WHEN ${table.workspaceId} = ${workspaceId} THEN ${table.totalAmount} ELSE 0 END)::bigint`.mapWith(
    Number,
  );
