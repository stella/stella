import type { MaybePromise } from "bun";
import { inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { INVOICE_STATUS, invoiceSends } from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { TransitionTransaction } from "@/api/lib/db/transitions";

export type InvoiceTransitionEffectContext<TTx extends TransitionTransaction> =
  {
    organizationId: SafeId<"organization">;
    actorUserId: SafeId<"user">;
    now: Date;
    recordAuditEvent: (
      tx: TTx,
      events: AuditEvent | AuditEvent[],
    ) => MaybePromise<void>;
  };

const revokedSendRow = v.object({
  id: resourceIdSchema("invoiceSend"),
  invoiceId: resourceIdSchema("invoice"),
});

type RevokeLiveInvoiceSendsOptions<TTx extends TransitionTransaction> =
  InvoiceTransitionEffectContext<TTx> & {
    invoiceId: SafeId<"invoice">;
    target:
      { type: "invoice" } | { type: "send"; sendId: SafeId<"invoiceSend"> };
  };

/** Pending sends also close: a transport completion cannot reactivate an old link. */
const revokeInvoiceSendSelection = async <TTx extends TransitionTransaction>(
  tx: TTx,
  {
    organizationId,
    invoiceIds,
    actorUserId,
    now,
    recordAuditEvent,
    target,
  }: InvoiceTransitionEffectContext<TTx> & {
    invoiceIds: readonly SafeId<"invoice">[];
    target: RevokeLiveInvoiceSendsOptions<TTx>["target"];
  },
) => {
  if (invoiceIds.length === 0) {
    return [];
  }
  const result = await tx.execute(sql`
    UPDATE ${invoiceSends}
    SET revoked_at = ${now}, revoked_by_user_id = ${actorUserId}
    WHERE ${invoiceSends.organizationId} = ${organizationId}
      AND ${inArray(invoiceSends.invoiceId, invoiceIds)}
      AND ${invoiceSends.revokedAt} IS NULL
      AND ${
        target.type === "send"
          ? sql`${invoiceSends.id} = ${target.sendId}`
          : sql`${invoiceSends.expiresAt} > ${now}::timestamptz`
      }
    RETURNING ${invoiceSends.id} AS "id", ${invoiceSends.invoiceId} AS "invoiceId"
  `);
  const revoked = executedRows(result).map((row) => ({
    ...v.parse(revokedSendRow, row),
    revokedAt: now,
  }));
  if (revoked.length > 0) {
    await recordAuditEvent(
      tx,
      revoked.map(({ id, invoiceId }) => ({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
        resourceId: invoiceId,
        changes: { linkRevoked: { old: false, new: true } },
        metadata: { invoiceSendId: id },
      })),
    );
  }
  return revoked;
};

export const revokeLiveInvoiceSends = async <TTx extends TransitionTransaction>(
  tx: TTx,
  { invoiceId, ...options }: RevokeLiveInvoiceSendsOptions<TTx>,
) =>
  await revokeInvoiceSendSelection(tx, { ...options, invoiceIds: [invoiceId] });

const INVOICE_LINK_AUTHORITY = {
  draft: "unissued",
  finalized: "issued",
  sent: "issued",
  paid: "issued",
  void: "unissued",
} as const satisfies Record<InvoiceStatus, "issued" | "unissued">;

const invoiceTransitionRow = v.object({
  id: resourceIdSchema("invoice"),
  status: v.picklist(Object.values(INVOICE_STATUS)),
  previousStatus: v.picklist(Object.values(INVOICE_STATUS)),
});

/** The transition engine supplies actual before/after states, never caller estimates. */
export const revokeInvoiceLinksAfterTransition = async <
  TTx extends TransitionTransaction,
>(
  tx: TTx,
  {
    context,
    rows,
  }: {
    context: InvoiceTransitionEffectContext<TTx>;
    rows: readonly Record<string, unknown>[];
  },
) => {
  const changed = rows.map((row) => v.parse(invoiceTransitionRow, row));
  const invoiceIds = changed
    .filter(
      (row) =>
        INVOICE_LINK_AUTHORITY[row.previousStatus] === "issued" &&
        INVOICE_LINK_AUTHORITY[row.status] === "unissued",
    )
    .map(({ id }) => id);
  await revokeInvoiceSendSelection(tx, {
    ...context,
    invoiceIds,
    target: { type: "invoice" },
  });
};
