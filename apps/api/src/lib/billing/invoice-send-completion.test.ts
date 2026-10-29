import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  INVOICE_STATUS,
  INVOICE_STATUSES,
  invoiceSends,
} from "@/api/db/schema";
import type { InvoiceSendDeliveryStatus, InvoiceStatus } from "@/api/db/schema";
import {
  INVOICE_SEND_COMPLETION,
  SEND_REVOCATION_STATES,
} from "@/api/lib/billing/invoice-send-completion";
import type { InvoiceSendDeliveryOutcome } from "@/api/lib/billing/invoice-send-delivery";

type SendRevocationState = (typeof SEND_REVOCATION_STATES)[number];
type CompletionCase = {
  invoiceStatus: InvoiceStatus;
  revocation: SendRevocationState;
  deliveryStatus: InvoiceSendDeliveryStatus;
  outcome: InvoiceSendDeliveryOutcome;
};
type CompletionDecision =
  (typeof INVOICE_SEND_COMPLETION)[InvoiceStatus][SendRevocationState][InvoiceSendDeliveryStatus][InvoiceSendDeliveryOutcome];

/** The behavioral contract, independent of the production decision table. */
const expectedCompletion = ({
  invoiceStatus,
  revocation,
  deliveryStatus,
  outcome,
}: CompletionCase): CompletionDecision => {
  const withdrawal = {
    type: "withdraw",
    previousDelivery: deliveryStatus === "pending" ? "pending" : "terminal",
  } as const;
  switch (revocation) {
    case "revoked":
      return withdrawal;
    case "live":
      break;
    default:
      revocation satisfies never;
      return panic("Unhandled send revocation state in the completion oracle");
  }
  switch (invoiceStatus) {
    case INVOICE_STATUS.DRAFT:
    case INVOICE_STATUS.VOID:
      return withdrawal;
    case INVOICE_STATUS.FINALIZED:
    case INVOICE_STATUS.SENT:
    case INVOICE_STATUS.PAID:
      break;
    default:
      invoiceStatus satisfies never;
      return panic("Unhandled invoice status in the completion oracle");
  }
  switch (deliveryStatus) {
    case "delivered":
    case "partial":
    case "failed":
      return { type: "stale" };
    case "pending":
      break;
    default:
      deliveryStatus satisfies never;
      return panic("Unhandled delivery status in the completion oracle");
  }
  switch (outcome) {
    case "failed":
      return { type: "fail" };
    case "delivered":
    case "partial":
      break;
    default:
      outcome satisfies never;
      return panic("Unhandled transport outcome in the completion oracle");
  }
  switch (invoiceStatus) {
    case INVOICE_STATUS.FINALIZED:
      return { type: "advance", deliveryStatus: outcome };
    case INVOICE_STATUS.SENT:
    case INVOICE_STATUS.PAID:
      return { type: "complete", deliveryStatus: outcome };
    default:
      invoiceStatus satisfies never;
      return panic("Unhandled issued invoice status in the completion oracle");
  }
};

const deliveryStatuses = invoiceSends.deliveryStatus.enumValues;
const outcomes = deliveryStatuses.filter(
  (status) => status !== "pending",
) satisfies readonly InvoiceSendDeliveryOutcome[];
const cases = INVOICE_STATUSES.flatMap((invoiceStatus) =>
  SEND_REVOCATION_STATES.flatMap((revocation) =>
    deliveryStatuses.flatMap((deliveryStatus) =>
      outcomes.map((outcome) => ({
        invoiceStatus,
        revocation,
        deliveryStatus,
        outcome,
      })),
    ),
  ),
) satisfies readonly CompletionCase[];

test("the completion matrix covers every persisted state and transport outcome exactly once", () => {
  const expectedCellCount =
    INVOICE_STATUSES.length *
    SEND_REVOCATION_STATES.length *
    deliveryStatuses.length *
    outcomes.length;
  expect(cases).toHaveLength(expectedCellCount);
  expect(new Set(cases.map((entry) => JSON.stringify(entry))).size).toBe(
    expectedCellCount,
  );
  expect(Object.keys(INVOICE_SEND_COMPLETION).toSorted()).toEqual(
    INVOICE_STATUSES.toSorted(),
  );
  for (const invoiceStatus of INVOICE_STATUSES) {
    const invoice = INVOICE_SEND_COMPLETION[invoiceStatus];
    expect(Object.keys(invoice).toSorted()).toEqual(
      SEND_REVOCATION_STATES.toSorted(),
    );
    for (const revocation of SEND_REVOCATION_STATES) {
      expect(Object.keys(invoice[revocation]).toSorted()).toEqual(
        deliveryStatuses.toSorted(),
      );
      for (const deliveryStatus of deliveryStatuses) {
        expect(
          Object.keys(invoice[revocation][deliveryStatus]).toSorted(),
        ).toEqual(outcomes.toSorted());
      }
    }
  }
});

test.each(cases)(
  "$invoiceStatus / $revocation / $deliveryStatus / SMTP $outcome follows the completion contract",
  (entry) => {
    const actual =
      INVOICE_SEND_COMPLETION[entry.invoiceStatus][entry.revocation][
        entry.deliveryStatus
      ][entry.outcome];
    expect(actual).toEqual(expectedCompletion(entry));
  },
);
