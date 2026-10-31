import * as v from "valibot";

import { moneySchema, moneyTextSchema } from "@stll/api-contract/billing-money";

const timeEntryMoney = v.looseObject({ rateAtEntry: v.nullable(moneySchema) });
export const timeEntryMoneyResponse = timeEntryMoney;
export const timeEntryPageMoneyResponse = v.looseObject({
  items: v.array(timeEntryMoney),
});
export const contactMoneyResponse = v.looseObject({
  defaultHourlyRate: v.nullable(moneySchema),
});
export const expenseMoneyResponse = v.looseObject({
  items: v.array(v.looseObject({ amount: moneySchema, markup: moneySchema })),
});
export const rateResolutionMoneyResponse = v.looseObject({
  hourlyRate: v.nullable(moneySchema),
});
export const rateEntryMoneyResponse = v.looseObject({
  items: v.array(v.looseObject({ hourlyRate: moneySchema })),
});
const arrangementMoney = v.looseObject({
  flatFeeAmount: v.nullable(moneySchema),
  capAmount: v.nullable(moneySchema),
});
export const arrangementMoneyResponse = v.looseObject({
  arrangement: v.nullable(arrangementMoney),
});
export const updatedArrangementMoneyResponse = arrangementMoney;
export const arrangementSummaryMoneyResponse = v.looseObject({
  summary: v.nullable(
    v.looseObject({
      billedAmount: v.optional(moneyTextSchema),
      approvedAmount: v.optional(moneyTextSchema),
      totalAmount: v.optional(moneyTextSchema),
      capAmount: v.optional(moneyTextSchema),
      remainingWipCapAmount: v.optional(moneyTextSchema),
      remainingInvoiceCapAmount: v.optional(moneyTextSchema),
    }),
  ),
});
const totals = v.looseObject({
  netAmountMinor: moneySchema,
  vatAmountMinor: moneySchema,
  grossAmountMinor: moneySchema,
  vatBreakdown: v.array(
    v.looseObject({
      netAmountMinor: moneySchema,
      vatAmountMinor: moneySchema,
      grossAmountMinor: moneySchema,
    }),
  ),
});
const invoiceAmounts = {
  totalAmount: moneySchema,
  paidAmount: moneySchema,
  outstandingAmount: moneySchema,
};
const invoiceLine = v.looseObject({
  unitPrice: moneySchema,
  netAmount: moneySchema,
  vatAmount: moneySchema,
  grossAmount: moneySchema,
  recordedUnitPrice: v.nullable(moneySchema),
  recordedNetAmount: v.nullable(moneySchema),
});
const payment = v.looseObject({ amount: moneySchema });
const invoiceTime = v.looseObject({ rateAtEntry: moneySchema });
const invoiceExpense = v.looseObject({
  amount: moneySchema,
  markup: moneySchema,
});
export const invoiceListMoneyResponse = v.looseObject({
  items: v.array(
    v.looseObject({
      ...invoiceAmounts,
      matterShare: moneySchema,
      flatFeeAmount: v.nullable(moneySchema),
    }),
  ),
});
export const invoiceDetailMoneyResponse = v.looseObject({
  ...invoiceAmounts,
  netAmount: moneySchema,
  vatAmount: moneySchema,
  flatFeeAmount: v.nullable(moneySchema),
  timeEntries: v.array(invoiceTime),
  expenses: v.array(invoiceExpense),
  lines: v.array(invoiceLine),
  totals,
  payments: v.array(payment),
});
export const invoicePaymentMoneyResponse = payment;
export const invoicePaymentsMoneyResponse = v.looseObject({
  paidAmount: moneySchema,
  outstandingAmount: moneySchema,
  items: v.array(payment),
});
export const invoiceLineMoneyResponse = v.looseObject({ totals });
export const invoiceTotalMoneyResponse = v.looseObject({
  totalAmount: moneySchema,
});
const prefill = v.looseObject({
  flatFeeAmount: v.nullable(moneySchema),
  timeEntries: v.array(invoiceTime),
  expenses: v.array(invoiceExpense),
});
export const invoicePrefillMoneyResponse = prefill;
export const clientInvoicePrefillMoneyResponse = v.looseObject({
  matters: v.array(v.looseObject({ prefill })),
});

export const createdInvoiceMoneyResponse = v.looseObject({
  totalAmount: v.nullable(moneySchema),
});
