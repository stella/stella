import { Result } from "better-result";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";
import { LimiterStoreUnavailableError } from "@/api/lib/rate-limit/store-unavailable";

export const INVOICE_LINK_TOKEN_BUDGET = { max: 20, duration: 60_000 } as const;

/** Both routes spend the same hash-keyed window, including unsuccessful lookups. */
export const createInvoiceLinkTokenAdmission =
  (context: Pick<RateLimitContext, "increment">) =>
  async (tokenHash: string) => {
    const counter = await Result.tryPromise({
      try: async () =>
        await context.increment(
          `invoice-link-token:${tokenHash}`,
          INVOICE_LINK_TOKEN_BUDGET.duration,
        ),
      catch: (cause) =>
        new HandlerError({
          ...LIMITER_STORE_UNAVAILABLE,
          cause: new LimiterStoreUnavailableError({
            operation: "increment",
            message: LIMITER_STORE_UNAVAILABLE.message,
            cause,
          }),
        }),
    });
    if (counter.isErr()) {
      return Result.err(counter.error);
    }
    const { count } = counter.value;
    if (count > INVOICE_LINK_TOKEN_BUDGET.max) {
      recordBudgetRejection({
        name: "api.invoice_link.token",
        keyKind: "bearer",
        windowMs: INVOICE_LINK_TOKEN_BUDGET.duration,
      });
      return Result.err(
        new HandlerError({
          status: 429,
          code: "invoice_link_limited",
          message: "Too many attempts. Try again later.",
        }),
      );
    }
    return Result.ok(undefined);
  };

let tokenAdmission:
  ReturnType<typeof createInvoiceLinkTokenAdmission> | undefined;

export const admitInvoiceLinkToken = async (tokenHash: string) => {
  tokenAdmission ??= createInvoiceLinkTokenAdmission(
    new RedisRateLimitContext({ failurePolicy: "fail_closed" }),
  );
  return await tokenAdmission(tokenHash);
};
