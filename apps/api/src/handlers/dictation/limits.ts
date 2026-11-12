import { Result } from "better-result";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type { BudgetName } from "@/api/lib/rate-limit/budget-observability";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
} from "@/api/lib/rate-limit/redis-context";

const WINDOW_MS = 60_000;
const USER_REQUESTS = 30;
const ORGANIZATION_REQUESTS = 120;
let binding: ReturnType<typeof createRedisRateLimit> | undefined;
const getContext = () =>
  (binding ??= createRedisRateLimit({
    scope: "dictation",
    failurePolicy: "fail_closed",
  })).context;

/** Each operation counts in budgets of its own: a dictation cleaned up after
 *  desktop transcription never spends the server transcription budget. */
const OPERATIONS = {
  transcribe: {
    counterPrefix: "dictation",
    userBudget: "dictation.user",
    organizationBudget: "dictation.organization",
    refusal: "Too many transcription requests",
  },
  cleanup: {
    counterPrefix: "dictation-cleanup",
    userBudget: "dictation_cleanup.user",
    organizationBudget: "dictation_cleanup.organization",
    refusal: "Too many dictation cleanup requests",
  },
} as const satisfies Record<
  string,
  {
    counterPrefix: string;
    userBudget: BudgetName;
    organizationBudget: BudgetName;
    refusal: string;
  }
>;

type DictationLimitOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  operation?: keyof typeof OPERATIONS;
  context?: Pick<RateLimitContext, "increment" | "decrement" | "complete">;
};

export const consumeDictationLimit = async ({
  userId,
  organizationId,
  operation = "transcribe",
  context = getContext(),
}: DictationLimitOptions): Promise<Result<void, HandlerError<429 | 503>>> => {
  const { counterPrefix, userBudget, organizationBudget, refusal } =
    OPERATIONS[operation];
  const budgets = (
    [
      {
        counterKey: `${counterPrefix}:user:${userId}`,
        maximum: USER_REQUESTS,
        name: userBudget,
        keyKind: "user",
      },
      {
        counterKey: `${counterPrefix}:organization:${organizationId}`,
        maximum: ORGANIZATION_REQUESTS,
        name: organizationBudget,
        keyKind: "organization",
      },
    ] as const
  ).map((budget) => ({
    ...budget,
    key: createRedisRateLimitRequestKey({
      counterKey: budget.counterKey,
      requestId: Bun.randomUUIDv7(),
    }),
  }));
  const counters = await Promise.allSettled(
    budgets.map(async ({ key, maximum, name, keyKind }) => {
      const counter = await context.increment(key, WINDOW_MS);
      if (counter.count <= maximum) {
        return true;
      }
      recordBudgetRejection({ name, keyKind, windowMs: WINDOW_MS });
      return false;
    }),
  );
  if (counters.some(({ status }) => status === "rejected")) {
    // Wait for both attempts before refunding; a rejected increment may also
    // have reached the store, whose request identity makes the refund safe.
    await Promise.allSettled(
      budgets.map(async ({ key }) => await context.decrement(key)),
    );
    return Result.err(new HandlerError(LIMITER_STORE_UNAVAILABLE));
  }
  const completed = await Result.tryPromise({
    try: async () =>
      await Promise.all(
        budgets.map(async ({ key }) => await context.complete(key)),
      ),
    catch: () => new HandlerError(LIMITER_STORE_UNAVAILABLE),
  });
  if (completed.isErr()) {
    return Result.err(completed.error);
  }
  return counters.every(
    (counter) => counter.status === "fulfilled" && counter.value,
  )
    ? Result.ok(undefined)
    : Result.err(
        new HandlerError({
          status: 429,
          code: "rate_limited",
          message: refusal,
          retryable: true,
          hint: "Wait one minute before retrying.",
        }),
      );
};
