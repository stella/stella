import { Result } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";
import { Temporal } from "@stll/time";

import { expenseCategorySchema } from "@/api/db/billing-validators";
import { expenses } from "@/api/db/schema";
import { expenseRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  minorUnitAmountSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const createExpenseBodySchema = v.object({
  matterId: resourceIdSchema("entity"),
  dateIncurred: apiDateSchema,
  timezoneId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  amount: minorUnitAmountSchema(1),
  currency: currencyCodeSchema,
  category: expenseCategorySchema,
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
  invoiceDescription: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
  ),
  billable: v.optional(v.boolean()),
  markup: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
  ),
});

const config = {
  contract: "patch",
  description:
    "Record a disbursement in the current matter against a work item " +
    "(matterId: the document, folder, or task the cost belongs to). amount " +
    "is an integer in minor currency units with a 3-letter currency; " +
    "dateIncurred is read in the timezoneId you pass and is refused when it " +
    "is in the future or older than the entry-age limit. The expense starts " +
    "as a draft.",
  permissions: { expense: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  realtime: expenseRealtimeUpdates,
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: createExpenseBodySchema,
} satisfies WorkspaceHandlerConfig;

const createExpense = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const todayStr = yield* formatTodayInTimeZone({
      timezoneId: body.timezoneId,
    });
    const dateIncurred = Temporal.PlainDate.from(body.dateIncurred);
    const today = Temporal.PlainDate.from(todayStr);

    if (Temporal.PlainDate.compare(dateIncurred, today) > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Date incurred cannot be in the future",
        }),
      );
    }

    const maxAgeCutoff = today.subtract({ days: LIMITS.timeEntryMaxAgeDays });
    if (Temporal.PlainDate.compare(dateIncurred, maxAgeCutoff) < 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Date incurred cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`,
        }),
      );
    }

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

    const totalExpenses = yield* Result.await(
      safeDb((tx) =>
        tx.$count(expenses, eq(expenses.workspaceId, workspaceId)),
      ),
    );

    if (totalExpenses >= LIMITS.expensesPerWorkspace) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Expenses limit reached for this workspace",
        }),
      );
    }

    const entry = yield* Result.await(
      safeDb(async (tx) => {
        const inserted = await tx
          .insert(expenses)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            matterId: body.matterId,
            dateIncurred: body.dateIncurred,
            amount: cents(body.amount),
            currency: body.currency,
            category: body.category,
            description: body.description,
            invoiceDescription: body.invoiceDescription ?? null,
            billable: body.billable ?? true,
            markup: body.markup ?? 0,
          })
          .returning({ id: expenses.id });

        const created = inserted.at(0);
        if (created) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
            resourceId: created.id,
            changes: {
              created: {
                old: null,
                new: {
                  matterId: body.matterId,
                  dateIncurred: body.dateIncurred,
                  amount: cents(body.amount),
                  currency: body.currency,
                  category: body.category,
                  billable: body.billable ?? true,
                  markup: body.markup ?? 0,
                },
              },
            },
          });
        }
        return created;
      }),
    );

    if (!entry) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to create expense",
        }),
      );
    }
    return Result.ok({ id: entry.id });
  },
);

export default createExpense;
