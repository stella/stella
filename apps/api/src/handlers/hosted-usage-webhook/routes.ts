/**
 * Hosted usage webhook route.
 *
 * Deliberately mounted OUTSIDE the auth macro — the route's
 * authentication is the HMAC signature check inside the handler.
 * The Elysia `parse: "text"` setting tells the framework to hand
 * us the raw request body as a string; we must NOT let it parse
 * JSON, because the HMAC is computed over the literal byte stream
 * the provider sent.
 */

import { panic } from "better-result";
import Elysia, { t } from "elysia";
import { rateLimit } from "elysia-rate-limit";

import { receiveHostedUsageWebhook } from "@/api/handlers/hosted-usage-webhook/receive";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit";

export const hostedUsageWebhookRoute = new Elysia({
  prefix: "/usage/hosted",
})
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.hostedUsageWebhook.duration,
      max: API_RATE_LIMITS.hostedUsageWebhook.max,
      generator: scopedGenerator("hosted-usage-webhook"),
      context: new InMemoryRateLimitContext(),
    }),
  )
  .post(
    "/webhook",
    async ({ request, body }) => {
      // The route schema below requires `body` to be a string at
      // runtime — Elysia rejects anything else before this handler
      // runs. The narrowing is here so TypeScript sees `string` for
      // the call below; a non-string at this point means the schema
      // was bypassed by a future refactor and we'd rather crash
      // visibly than run HMAC verification over a coerced "".
      if (typeof body !== "string") {
        panic("hosted usage webhook body bypassed t.String schema");
      }
      return await receiveHostedUsageWebhook({ request, body });
    },
    {
      // 64 KiB cap. Webhook payloads are typically 5-50 KB;
      // anything significantly larger is pathological or malicious
      // (HMAC verification still costs CPU per byte). Combined
      // with the per-IP rate limit above, this bounds the worst
      // case an unauthenticated attacker can drive.
      body: t.String({ maxLength: 65_536 }),
      parse: "text",
    },
  );
