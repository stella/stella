import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import { VAT_TREATMENTS } from "@stll/invoicing";

import { billingArrangements, expenses } from "@/api/db/schema";
import { safeHandlerResponseSchemas } from "@/api/lib/api-handlers";
import type { EMPTY_BUYER_SNAPSHOT } from "@/api/lib/billing/invoice-prefill.logic";
import { INVOICE_VAT_REASONS } from "@/api/lib/billing/invoice-prefill.logic";

const nullableText = t.Union([t.String(), t.Null()]);
const buyerSchema = t.Object({
  buyerName: nullableText,
  buyerRegistrationId: nullableText,
  buyerVatId: nullableText,
  buyerAddressLine1: nullableText,
  buyerAddressLine2: nullableText,
  buyerCity: nullableText,
  buyerPostalCode: nullableText,
  buyerCountry: nullableText,
} satisfies Record<keyof typeof EMPTY_BUYER_SNAPSHOT, TSchema>);

export const invoicePrefillResponseSchema = safeHandlerResponseSchemas(
  t.Object({
    currency: nullableText,
    invoiceDate: t.String(),
    taxableSupplyDate: t.String(),
    dueDays: t.Number(),
    dueDaysSource: t.UnionEnum(["client", "default"]),
    seller: t.Union([
      t.Null(),
      t.Object({
        id: t.String(),
        legalName: t.String(),
        vatId: nullableText,
        vatPayer: t.Boolean(),
        defaultCurrency: t.String(),
      }),
    ]),
    sellerSource: t.UnionEnum(["requested", "default", "none", "not_found"]),
    buyer: buyerSchema,
    buyerSource: t.UnionEnum(["none", "client"]),
    vat: t.Object({
      vatTreatment: t.UnionEnum(VAT_TREATMENTS),
      vatRateBps: t.Number(),
      reason: t.UnionEnum(INVOICE_VAT_REASONS),
    }),
    vatRatePeriods: t.Array(
      t.Object({
        validFrom: t.String(),
        validTo: nullableText,
        rateBps: t.Number(),
      }),
    ),
    billingMode: t.UnionEnum(billingArrangements.mode.enumValues),
    flatFeeAmount: t.Union([t.Number(), t.Null()]),
    timeEntries: t.Array(
      t.Object({
        id: t.String(),
        userId: nullableText,
        dateWorked: t.String(),
        durationMinutes: t.Number(),
        billedMinutes: t.Number(),
        rateAtEntry: t.Number(),
        currency: t.String(),
        narrative: t.String(),
        invoiceNarrative: nullableText,
        noCharge: t.Boolean(),
        taskCode: nullableText,
        activityCode: nullableText,
        timekeeperName: nullableText,
      }),
    ),
    expenses: t.Array(
      t.Object({
        id: t.String(),
        dateIncurred: t.String(),
        amount: t.Number(),
        markup: t.Number(),
        currency: t.String(),
        category: t.UnionEnum(expenses.category.enumValues),
        description: t.String(),
        invoiceDescription: nullableText,
      }),
    ),
  }),
);
