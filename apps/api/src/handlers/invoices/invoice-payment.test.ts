import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { INVOICE_STATUS } from "@/api/db/schema";
import { cents } from "@/api/lib/money";

import {
  EMPTY_INVOICE_PAYMENT,
  prepareInvoicePayment,
} from "./invoice-payment";

const NOW = new Date("2026-09-30T23:50:00Z");
const sent = {
  ...EMPTY_INVOICE_PAYMENT,
  status: INVOICE_STATUS.SENT,
  documentType: "invoice",
  totalAmount: cents(1000),
} as const;

describe("invoice payment lifecycle", () => {
  test("omitted metadata replays the original payment on a later UTC day", () => {
    const first = prepareInvoicePayment({
      invoice: sent,
      body: { action: "mark_paid", note: "bank transfer", reference: "R1" },
      memberRole: { role: "owner" },
      now: NOW,
    });
    expect(first.isOk()).toBe(true);
    expect(first).toMatchObject({ value: { type: "update" } });
    if (first.isErr() || first.value.type !== "update") {
      panic("First payment did not create metadata");
    }
    const paid = {
      ...sent,
      ...first.value.fields,
      status: INVOICE_STATUS.PAID,
    } as const;
    expect(
      prepareInvoicePayment({
        invoice: paid,
        body: { action: "mark_paid" },
        memberRole: { role: "owner" },
        now: new Date("2026-10-02T00:01:00Z"),
      }),
    ).toMatchObject({ value: { type: "replay" } });
  });

  test.each([0, 999, 1001])(
    "refuses non-full amount %p without writing down or crediting",
    (paidAmountMinor) => {
      expect(
        prepareInvoicePayment({
          invoice: sent,
          body: { action: "mark_paid", paidAmountMinor },
          memberRole: { role: "owner" },
          now: NOW,
        }),
      ).toMatchObject({
        error: { code: "partial_payment_not_supported", status: 409 },
      });
    },
  );

  test("calendar validation rejects impossible dates", () => {
    expect(
      prepareInvoicePayment({
        invoice: sent,
        body: { action: "mark_paid", paidDate: "2026-02-30" },
        memberRole: { role: "owner" },
        now: NOW,
      }),
    ).toMatchObject({ error: { code: "payment_date_invalid", status: 400 } });
  });

  test.each(["owner", "admin", "member"] as const)(
    "undo decision uses organization role %s",
    (role) => {
      const paid = {
        ...sent,
        status: INVOICE_STATUS.PAID,
        paidAt: NOW,
        paidDate: "2026-09-30",
        paidAmount: cents(1000),
      } as const;
      const result = prepareInvoicePayment({
        invoice: paid,
        body: { action: "undo_paid" },
        memberRole: { role },
        now: NOW,
      });
      if (role === "member") {
        expect(result).toMatchObject({
          error: { code: "payment_undo_forbidden", status: 403 },
        });
      } else {
        expect(result).toMatchObject({
          value: { type: "update", fields: EMPTY_INVOICE_PAYMENT },
        });
      }
    },
  );

  test("legacy paidAt-only rows replay their recorded date and total", () => {
    const legacy = {
      ...sent,
      status: INVOICE_STATUS.PAID,
      paidAt: NOW,
    } as const;
    expect(
      prepareInvoicePayment({
        invoice: legacy,
        body: {
          action: "mark_paid",
          paidDate: "2026-09-30",
          paidAmountMinor: 1000,
        },
        memberRole: { role: "owner" },
        now: new Date("2026-10-02T00:00:00Z"),
      }),
    ).toMatchObject({ value: { type: "replay" } });
    expect(
      prepareInvoicePayment({
        invoice: { ...legacy, paidAt: null },
        body: { action: "mark_paid" },
        memberRole: { role: "owner" },
        now: NOW,
      }),
    ).toMatchObject({
      error: { code: "payment_details_conflict", status: 409 },
    });
  });
});
