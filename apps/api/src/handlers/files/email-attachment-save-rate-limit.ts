import { API_RATE_LIMITS } from "@/api/lib/limits";
import { scopedRateLimitKey } from "@/api/lib/rate-limit/rate-limit";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

const EMAIL_ATTACHMENT_SAVE_RATE_LIMIT_SCOPE = "upload";

type RateLimitCounterContext = Pick<RedisRateLimitContext, "increment">;

let defaultContext: RedisRateLimitContext | undefined;

const getDefaultContext = (): RedisRateLimitContext => {
  defaultContext ??= new RedisRateLimitContext({
    failurePolicy: "fail_open_local",
  });
  return defaultContext;
};

export const consumeEmailAttachmentSaveRateLimit = async ({
  context = getDefaultContext(),
  request,
  server,
}: {
  context?: RateLimitCounterContext;
  request: Request;
  server: Parameters<typeof scopedRateLimitKey>[2];
}): Promise<boolean> => {
  const counter = await context.increment(
    scopedRateLimitKey(EMAIL_ATTACHMENT_SAVE_RATE_LIMIT_SCOPE, request, server),
    API_RATE_LIMITS.upload.duration,
  );
  return counter.count <= API_RATE_LIMITS.upload.max;
};
