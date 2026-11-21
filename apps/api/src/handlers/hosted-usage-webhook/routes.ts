/**
 * Hosted usage webhook route.
 *
 * It takes no session: the route's authentication is the HMAC signature check
 * inside the handler. The body is read as text, never parsed as JSON, because
 * the HMAC is computed over the literal byte stream the provider sent.
 */
import * as v from "valibot";

import { receiveHostedUsageWebhook } from "@/api/handlers/hosted-usage-webhook/receive";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const hostedUsageWebhook = defineEndpoint.public(
  {
    // 64 KiB cap. Webhook payloads are typically 5-50 KB; anything
    // significantly larger is pathological or malicious (HMAC verification
    // still costs CPU per byte). Combined with the per-IP rate limit, this
    // bounds the worst case an unauthenticated caller can drive.
    body: v.pipe(v.string(), v.maxLength(65_536)),
    bodyMode: "text",
  },
  async ({ request, body }) =>
    await receiveHostedUsageWebhook({ request, body }),
);

export const hostedUsageWebhookRoute = routes(
  { "/webhook": { POST: hostedUsageWebhook } },
  {
    prefix: "/usage/hosted",
    middleware: [
      rateLimit({
        duration: API_RATE_LIMITS.hostedUsageWebhook.duration,
        max: API_RATE_LIMITS.hostedUsageWebhook.max,
        budget: {
          name: "api.hosted_usage_webhook.address",
          keyKind: "address",
        },
        ...createRedisRateLimit({
          failurePolicy: "fail_open_local",
          scope: "hosted-usage-webhook",
        }),
      }),
    ],
  },
);
