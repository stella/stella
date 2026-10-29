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
import {
  createRedisRateLimitRequestKey,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";

export const INVOICE_EMAIL_BUDGET = {
  durationMs: DAY_IN_MS,
  userEmails: 50,
  platformEmails: 20_000,
  organizationEmails: 200,
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

export type InvoiceEmailReservation = {
  /** Return every recipient slot when no transport has started. */
  release: () => Promise<void>;
  /** Retain charges once transport has started, even when delivery fails. */
  commit: () => Promise<void>;
};

const counterUnavailable = (cause: unknown) =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: LIMITER_STORE_UNAVAILABLE.code,
      message: "Invoice email delivery is temporarily unavailable.",
      cause,
    }),
    "upstream_unavailable",
  );

/** Each slot has its own refund identity, including an ambiguous store reply. */
export const createInvoiceEmailAdmission =
  (context: Pick<RateLimitContext, "increment" | "decrement" | "complete">) =>
  async (
    options: InvoiceEmailAdmissionOptions,
  ): Promise<Result<InvoiceEmailReservation, HandlerError>> => {
    const young =
      options.now.getTime() - options.organizationCreatedAt.getTime() <
      INVOICE_EMAIL_BUDGET.youngOrganizationAgeMs;
    const budgets: EmailBudget[] = [
      {
        key: `invoice-email:organization:${sha256Hex(options.organizationId)}`,
        max: INVOICE_EMAIL_BUDGET.organizationEmails,
        name: "api.invoice_email.organization",
        keyKind: "account",
      },
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
    if (young) {
      budgets.unshift({
        key: `invoice-email:young-organization:${sha256Hex(options.organizationId)}`,
        max: INVOICE_EMAIL_BUDGET.youngOrganizationEmails,
        name: "api.invoice_email.young_organization",
        keyKind: "account",
      });
    }
    const attemptedKeys: string[] = [];
    const execution: { phase: "reserved" | "settled" } = { phase: "reserved" };
    const settle = async (outcome: "release" | "commit") => {
      if (execution.phase === "settled") {
        return;
      }
      execution.phase = "settled";
      await Promise.all(
        attemptedKeys.map(async (key) => {
          try {
            if (outcome === "release") {
              await context.decrement(key);
            }
          } finally {
            await context.complete(key);
          }
        }),
      );
    };
    const refuse = async (error: HandlerError) => {
      const refunded = await Result.tryPromise({
        try: async () => await settle("release"),
        catch: counterUnavailable,
      });
      return Result.err(refunded.isErr() ? refunded.error : error);
    };
    for (const budget of budgets) {
      const slots = await Promise.all(
        Array.from({ length: options.recipientCount }, async () => {
          const key = createRedisRateLimitRequestKey({
            counterKey: budget.key,
            requestId: Bun.randomUUIDv7(),
          });
          attemptedKeys.push(key);
          return await Result.tryPromise({
            try: async () =>
              await context.increment(key, INVOICE_EMAIL_BUDGET.durationMs),
            catch: counterUnavailable,
          });
        }),
      );
      for (const slot of slots) {
        if (slot.isErr()) {
          return await refuse(slot.error);
        }
      }
      if (slots.some((slot) => slot.isOk() && slot.value.count > budget.max)) {
        recordBudgetRejection({
          name: budget.name,
          keyKind: budget.keyKind,
          windowMs: INVOICE_EMAIL_BUDGET.durationMs,
        });
        return await refuse(
          new HandlerError({
            status: 429,
            code: "invoice_email_limit",
            message:
              "The daily invoice email limit was reached. Try again later.",
          }),
        );
      }
    }
    return Result.ok({
      release: async () => await settle("release"),
      commit: async () => await settle("commit"),
    });
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
