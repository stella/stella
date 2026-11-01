import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { invoiceSends } from "@/api/db/schema";
import type { InvoiceSendDeliveryStatus } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionLifecycle } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export type InvoiceSendDeliveryOutcome = Exclude<
  InvoiceSendDeliveryStatus,
  "pending"
>;

type CompleteInvoiceSendDeliveryOptions = {
  sendId: SafeId<"invoiceSend">;
  invoiceId: SafeId<"invoice">;
  deliveryStatus: InvoiceSendDeliveryOutcome;
  failedRecipients: string[];
  now: Date;
  recordAuditEvent: AuditRecorder;
};

/** Complete one attempt and its audit together; failed attempts revoke their link atomically. */
export const completeInvoiceSendDelivery = async (
  tx: Transaction,
  options: CompleteInvoiceSendDeliveryOptions,
): Promise<Result<void, HandlerError>> => {
  const completed = await transitionLifecycle({
    tx,
    spec: TRANSITIONS.invoiceSends,
    id: options.sendId,
    moves: {
      deliveryStatus: { from: ["pending"], to: options.deliveryStatus },
    },
    set: {
      failedRecipients: options.failedRecipients,
      ...(options.deliveryStatus === "failed"
        ? {
            revokedAt: sql`coalesce(${invoiceSends.revokedAt}, ${options.now})`,
          }
        : {}),
    },
    recordTransitionAuditEvent: async (auditTx) => {
      await options.recordAuditEvent(auditTx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
        resourceId: options.invoiceId,
        changes: {
          emailDelivery: { old: "pending", new: options.deliveryStatus },
        },
        metadata: {
          invoiceSendId: options.sendId,
          failedRecipients: options.failedRecipients,
        },
      });
    },
  });
  switch (completed.type) {
    case "transitioned":
      return Result.ok(undefined);
    case "stale":
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The invoice email delivery state changed before completion",
        }),
      );
    default:
      completed satisfies never;
      return panic("Unhandled invoice send completion result");
  }
};
