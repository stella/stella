import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { outerColumnReference } from "@/api/lib/db/outer-column-reference";

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
  sql`(${outerColumnReference(table.workspaceId)} = ${workspaceId} OR EXISTS (SELECT 1 FROM public.invoice_lines scope_line WHERE scope_line.invoice_id = ${outerColumnReference(table.id)} AND scope_line.workspace_id = ${workspaceId}))`;

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
  sql`(${invoiceTouchesMatter(table, workspaceId)} OR (${outerColumnReference(table.workspaceId)} IS NULL AND EXISTS (SELECT 1 FROM public.workspaces invoice_matter WHERE invoice_matter.id = ${workspaceId} AND invoice_matter.organization_id = ${outerColumnReference(table.organizationId)} AND invoice_matter.client_id = ${outerColumnReference(table.clientId)})))`;

/**
 * Tool matter scope covers this invoice and every matter of its linked
 * original. RLS already binds an explicit credential matter set (lines outside
 * it are invisible here); this binds a tool scope narrower than membership.
 */
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
  return sql`((${outerColumnReference(table.workspaceId)} IS NULL OR ${outerColumnReference(table.workspaceId)} IN (${allowed})) AND NOT EXISTS (SELECT 1 FROM public.invoice_lines credential_line WHERE credential_line.invoice_id IN (${outerColumnReference(table.id)}, ${outerColumnReference(table.originalInvoiceId)}) AND credential_line.workspace_id NOT IN (${allowed})))`;
};

type InvoiceShareColumns = {
  id: SQLWrapper;
  workspaceId: SQLWrapper;
  totalAmount: SQLWrapper;
};

/**
 * The part of an invoice a matter bills. A single-matter invoice is wholly its
 * matter's, so the share is its stored total, the same figure its detail and
 * list show (a legacy draft's attached entries count there before they have
 * lines). A client invoice spreads over matters, so a matter's share is the sum
 * of its lines there.
 */
export const invoiceMatterShare = (
  table: InvoiceShareColumns,
  workspaceId: SafeId<"workspace">,
) =>
  sql<number>`(CASE WHEN ${outerColumnReference(table.workspaceId)} IS NOT NULL THEN CASE WHEN ${outerColumnReference(table.workspaceId)} = ${workspaceId} THEN ${outerColumnReference(table.totalAmount)} ELSE 0 END ELSE COALESCE((SELECT SUM(share_line.gross_amount) FROM public.invoice_lines share_line WHERE share_line.invoice_id = ${outerColumnReference(table.id)} AND share_line.workspace_id = ${workspaceId}), 0) END)::bigint`.mapWith(
    Number,
  );
