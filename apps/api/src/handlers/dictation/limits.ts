import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
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

type DictationLimitOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  context?: Pick<RateLimitContext, "increment" | "complete">;
};

export const consumeDictationLimit = async ({
  userId,
  organizationId,
  context = getContext(),
}: DictationLimitOptions): Promise<Result<void, HandlerError<429 | 503>>> => {
  const counters = await Result.tryPromise({
    try: async () =>
      await Promise.all(
        (
          [
            {
              counterKey: `dictation:user:${userId}`,
              maximum: USER_REQUESTS,
              name: "dictation.user",
              keyKind: "user",
            },
            {
              counterKey: `dictation:organization:${organizationId}`,
              maximum: ORGANIZATION_REQUESTS,
              name: "dictation.organization",
              keyKind: "organization",
            },
          ] as const
        ).map(async ({ counterKey, maximum, name, keyKind }) => {
          const key = createRedisRateLimitRequestKey({
            counterKey,
            requestId: Bun.randomUUIDv7(),
          });
          const counter = await context.increment(key, WINDOW_MS);
          await context.complete(key);
          if (counter.count <= maximum) {
            return true;
          }
          recordBudgetRejection({ name, keyKind, windowMs: WINDOW_MS });
          return false;
        }),
      ),
    catch: () =>
      new HandlerError({
        status: 503,
        code: "limiter_store_unavailable",
        message: "Request admission is unavailable",
        retryable: true,
      }),
  });
  if (counters.isErr()) {
    return Result.err(counters.error);
  }
  return counters.value.every(Boolean)
    ? Result.ok(undefined)
    : Result.err(
        new HandlerError({
          status: 429,
          code: "rate_limited",
          message: "Too many transcription requests",
          retryable: true,
          hint: "Wait one minute before retrying.",
        }),
      );
};
