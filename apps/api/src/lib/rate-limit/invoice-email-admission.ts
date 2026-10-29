import { Result } from "better-result";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";
import { classifyFailure } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/bun";
import { DAY_IN_MS } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type {
  BudgetKeyKind,
  BudgetName,
} from "@/api/lib/rate-limit/budget-observability";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

export const INVOICE_EMAIL_BUDGET = {
  durationMs: DAY_IN_MS,
  userEmails: 50,
  platformEmails: 1000,
  youngOrganizationEmails: 10,
  youngOrganizationAgeMs: 14 * DAY_IN_MS,
} as const;

type InvoiceEmailAdmissionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  organizationCreatedAt: Date;
  recipientCount: number;
  now: Date;
};

type EmailBudget = {
  key: string;
  max: number;
  name: BudgetName;
  keyKind: BudgetKeyKind;
};

/**
 * Each recipient reserves one atomic counter slot. Refused batches and failed
 * deliveries keep their reservations so retries cannot reclaim the quota.
 */
export const createInvoiceEmailAdmission =
  (context: Pick<RateLimitContext, "increment">) =>
  async (
    options: InvoiceEmailAdmissionOptions,
  ): Promise<Result<void, HandlerError>> => {
    const budgets: EmailBudget[] = [
      {
        key: `invoice-email:user:${sha256Hex(options.userId)}`,
        max: INVOICE_EMAIL_BUDGET.userEmails,
        name: "api.invoice_email.user",
        keyKind: "user",
      },
      {
        key: "invoice-email:platform",
        max: INVOICE_EMAIL_BUDGET.platformEmails,
        name: "api.invoice_email.platform",
        keyKind: "account",
      },
    ];
    if (
      options.now.getTime() - options.organizationCreatedAt.getTime() <
      INVOICE_EMAIL_BUDGET.youngOrganizationAgeMs
    ) {
      budgets.unshift({
        key: `invoice-email:young-organization:${sha256Hex(options.organizationId)}`,
        max: INVOICE_EMAIL_BUDGET.youngOrganizationEmails,
        name: "api.invoice_email.young_organization",
        keyKind: "account",
      });
    }
    // Rejected attempts consume earlier windows; later windows are untouched.
    // The broad platform quota is charged only after both narrower caps admit.
    for (const budget of budgets) {
      const reserved = await Result.tryPromise({
        try: async () =>
          await Promise.all(
            Array.from(
              { length: options.recipientCount },
              async () =>
                await context.increment(
                  budget.key,
                  INVOICE_EMAIL_BUDGET.durationMs,
                ),
            ),
          ),
        catch: (cause) =>
          classifyFailure(
            new HandlerError({
              status: 503,
              code: LIMITER_STORE_UNAVAILABLE.code,
              message: "Invoice email delivery is temporarily unavailable.",
              cause,
            }),
            "upstream_unavailable",
          ),
      });
      if (reserved.isErr()) {
        return Result.err(reserved.error);
      }
      if (reserved.value.some(({ count }) => count > budget.max)) {
        recordBudgetRejection({
          name: budget.name,
          keyKind: budget.keyKind,
          windowMs: INVOICE_EMAIL_BUDGET.durationMs,
        });
        return Result.err(
          new HandlerError({
            status: 429,
            code: "invoice_email_limit",
            message:
              "The daily invoice email limit was reached. Try again later.",
          }),
        );
      }
    }
    return Result.ok(undefined);
  };

let admission: ReturnType<typeof createInvoiceEmailAdmission> | undefined;

/** Shared across replicas; an unavailable store refuses the send. No local fallback. */
export const admitInvoiceEmail = async (
  options: InvoiceEmailAdmissionOptions,
) => {
  admission ??= createInvoiceEmailAdmission(
    new RedisRateLimitContext({ failurePolicy: "fail_closed" }),
  );
  return await admission(options);
};
