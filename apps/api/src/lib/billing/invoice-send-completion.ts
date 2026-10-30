import { INVOICE_STATUS } from "@/api/db/schema";
import type { InvoiceSendDeliveryStatus, InvoiceStatus } from "@/api/db/schema";
import type { InvoiceSendDeliveryOutcome } from "@/api/lib/billing/invoice-send-delivery";

export const SEND_REVOCATION_STATES = ["live", "revoked"] as const;
type SendRevocationState = (typeof SEND_REVOCATION_STATES)[number];

type AcceptedDelivery = Exclude<InvoiceSendDeliveryOutcome, "failed">;
type CompletionDecision =
  | { type: "advance"; deliveryStatus: AcceptedDelivery }
  | { type: "complete"; deliveryStatus: AcceptedDelivery }
  | { type: "fail" }
  | { type: "withdraw"; previousDelivery: "pending" | "terminal" }
  | { type: "stale" };

type TransportDecisions = Record<
  InvoiceSendDeliveryOutcome,
  CompletionDecision
>;
type SendDecisions = Record<InvoiceSendDeliveryStatus, TransportDecisions>;

const WITHDRAW_PENDING = {
  delivered: { type: "withdraw", previousDelivery: "pending" },
  partial: { type: "withdraw", previousDelivery: "pending" },
  failed: { type: "withdraw", previousDelivery: "pending" },
} as const satisfies TransportDecisions;

const WITHDRAW_TERMINAL = {
  delivered: { type: "withdraw", previousDelivery: "terminal" },
  partial: { type: "withdraw", previousDelivery: "terminal" },
  failed: { type: "withdraw", previousDelivery: "terminal" },
} as const satisfies TransportDecisions;

const WITHDRAW = {
  pending: WITHDRAW_PENDING,
  delivered: WITHDRAW_TERMINAL,
  partial: WITHDRAW_TERMINAL,
  failed: WITHDRAW_TERMINAL,
} as const satisfies SendDecisions;

const STALE = {
  delivered: { type: "stale" },
  partial: { type: "stale" },
  failed: { type: "stale" },
} as const satisfies TransportDecisions;

const COMPLETE = {
  pending: {
    delivered: { type: "complete", deliveryStatus: "delivered" },
    partial: { type: "complete", deliveryStatus: "partial" },
    failed: { type: "fail" },
  },
  delivered: STALE,
  partial: STALE,
  failed: STALE,
} as const satisfies SendDecisions;

const ADVANCE = {
  pending: {
    delivered: { type: "advance", deliveryStatus: "delivered" },
    partial: { type: "advance", deliveryStatus: "partial" },
    failed: { type: "fail" },
  },
  delivered: STALE,
  partial: STALE,
  failed: STALE,
} as const satisfies SendDecisions;

/** A send's authority is never restored when its invoice is issued again. */
export const INVOICE_SEND_COMPLETION = {
  [INVOICE_STATUS.DRAFT]: { live: WITHDRAW, revoked: WITHDRAW },
  [INVOICE_STATUS.FINALIZED]: { live: ADVANCE, revoked: WITHDRAW },
  [INVOICE_STATUS.SENT]: { live: COMPLETE, revoked: WITHDRAW },
  [INVOICE_STATUS.PAID]: { live: COMPLETE, revoked: WITHDRAW },
  [INVOICE_STATUS.VOID]: { live: WITHDRAW, revoked: WITHDRAW },
} as const satisfies Record<
  InvoiceStatus,
  Record<SendRevocationState, SendDecisions>
>;
