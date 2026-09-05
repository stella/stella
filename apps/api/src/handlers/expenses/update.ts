import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { toMajorUnits, tryToMinorUnits } from "@stll/money";

import { expenseCategorySchema } from "@/api/db/billing-validators";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  tCurrencyCode,
  tMinorUnitAmount,
  tSafeId,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";

const updateExpenseBodySchema = t.Object({
  id: tSafeId("expense"),
  dateIncurred: t.Optional(t.String({ format: "date" })),
  amount: t.Optional(tMinorUnitAmount(1)),
  currency: t.Optional(tCurrencyCode),
  category: t.Optional(expenseCategorySchema),
  description: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
  invoiceDescription: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  billable: t.Optional(t.Boolean()),
  markup: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
  matterId: t.Optional(tSafeId("entity")),
  status: t.Optional(
    t.Union([
      t.Literal(BILLING_STATUS.DRAFT),
      t.Literal(BILLING_STATUS.APPROVED),
    ]),
  ),
});

const config = {
  description:
    "Change a draft or approved expense in a matter: its date, amount, " +
    "currency, category, description, invoice description, billable flag, " +
    "markup, work item, or status (draft or approved). A billed or " +
    "written-off expense is refused; use expenses.delete to write off an " +
    "unbilled one.",
  permissions: { expense: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  body: updateExpenseBodySchema,
} satisfies HandlerConfig;

const updateExpense = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.expenses.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            status: true,
            dateIncurred: true,
            amount: true,
            currency: true,
            category: true,
            description: true,
            invoiceDescription: true,
            billable: true,
            markup: true,
            matterId: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Expense not found" }),
      );
    }

    if (
      existing.status === BILLING_STATUS.BILLED ||
      existing.status === BILLING_STATUS.WRITTEN_OFF
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot edit a billed or written-off expense",
        }),
      );
    }

    if (body.matterId !== undefined) {
      const matter = yield* Result.await(
        safeDb((tx) =>
          tx.query.entities.findFirst({
            where: {
              id: { eq: body.matterId },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
          }),
        ),
      );

      if (!matter) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Matter not found in this workspace",
          }),
        );
      }
    }

    // The stored integer means nothing without its currency: 1250 is 12.50 USD
    // and 1250 JPY. A currency change that leaves the amount alone would
    // therefore silently restate the expense's value, so restate it here
    // instead, in the transaction that changes the code. An amount sent
    // alongside the currency is already in the new currency's units and wins
    // as given.
    // The currency this update restates the amount INTO, or null when it does
    // not restate: an amount sent alongside the currency is already in the new
    // currency's units and wins as given.
    const restatementCurrency =
      body.amount === undefined &&
      body.currency !== undefined &&
      body.currency !== existing.currency
        ? body.currency
        : null;
    const restatedAmount =
      restatementCurrency === null
        ? null
        : tryToMinorUnits({
            amount: toMajorUnits({
              amountCents: existing.amount,
              currency: existing.currency,
            }),
            currency: restatementCurrency,
          });

    // Both ends of the new currency's range, refused before anything is
    // written. Too small: a zero would break `expenses_amount_positive_check`.
    // Too large: `tryToMinorUnits` declines a scaled value past the safe
    // integer range, where the stored amount stops being the one it names --
    // three decimals from none multiplies by a thousand, so an amount well
    // inside the old currency's range can leave it.
    if (
      restatementCurrency !== null &&
      (restatedAmount === null || restatedAmount < 1)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "This expense cannot be restated in the new currency; " +
            "send the amount in that currency instead",
        }),
      );
    }

    const updates = {
      ...pickDefined(body, [
        "dateIncurred",
        "currency",
        "category",
        "description",
        "invoiceDescription",
        "billable",
        "markup",
        "matterId",
        "status",
      ]),
      ...(restatedAmount === null ? {} : { amount: restatedAmount }),
      ...(body.amount !== undefined ? { amount: cents(body.amount) } : {}),
      updatedAt: new Date(),
    };

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(expenses)
          .set(updates)
          .where(
            and(
              eq(expenses.id, body.id),
              eq(expenses.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
          resourceId: body.id,
          changes: buildExpenseDiff(existing, updates),
        });
      }),
    );

    return Result.ok({ id: body.id });
  },
);

const buildExpenseDiff = (
  before: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> => {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key === "updatedAt") {
      continue;
    }
    diff[key] = { old: before[key] ?? null, new: value };
  }
  return diff;
};

export default updateExpense;
