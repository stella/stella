import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
} from "@/api/lib/rate-limit/redis-context";

/** Account actions are independent of organization service admission. */
const ACCOUNT_ACTION_KIND = {
  dataExportRequest: "account-export.request",
} as const;
let accountActionContext: RateLimitContext | undefined;
const getAccountActionContext = () => {
  accountActionContext ??= createRedisRateLimit({
    scope: "account-action",
    failurePolicy: "fail_closed",
  }).context;
  return accountActionContext;
};

type AdmitAccountExportRequestOptions = {
  userId: SafeId<"user">;
  max: number;
  durationMs: number;
  context?: Pick<RateLimitContext, "increment" | "complete">;
};

export const admitAccountExportRequest = async ({
  userId,
  max,
  durationMs,
  context = getAccountActionContext(),
}: AdmitAccountExportRequestOptions): Promise<Result<void, HandlerError>> => {
  const key = createRedisRateLimitRequestKey({
    counterKey: `${ACCOUNT_ACTION_KIND.dataExportRequest}:${userId}`,
    requestId: Bun.randomUUIDv7(),
  });
  const counter = await context.increment(key, durationMs);
  await context.complete(key);
  if (counter.count > max) {
    return Result.err(
      new HandlerError({
        status: 429,
        code: "account_export_request_limited",
        message: "Try again later.",
      }),
    );
  }
  return Result.ok();
};
