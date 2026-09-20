/**
 * The two HTTP entry points into the feedback pipeline.
 *
 * `POST /public/feedback` is deliberately mounted OUTSIDE the auth macro: the
 * caller may have no Stella account at all, which is the whole reason the
 * intake exists. Its protection is the strict body validation plus the per-IP
 * rate limit enforced inside `receivePublicFeedback`, not identity.
 * `parse: "text"` hands the handler the raw body string, because Elysia's
 * normalizer would strip unknown keys before a typed schema could reject them;
 * the route keeps only a coarse size cap as defense in depth.
 *
 * `POST /v1/feedback` is the authenticated route the web and desktop apps use.
 * It is mounted at the root, like `/v1/notifications`: folding another `.use()`
 * into the large `/v1` group tips Elysia's inferred type past TypeScript's
 * complexity threshold and collapses Eden's client types across the whole web
 * app.
 */

import { panic } from "better-result";
import Elysia, { t } from "elysia";

import createFeedbackReport from "@/api/handlers/feedback/create";
import {
  MAX_RAW_FEEDBACK_BODY_CHARS,
  receivePublicFeedback,
} from "@/api/handlers/feedback/intake";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { resolveClientIp } from "@/api/lib/client-ip";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

export const feedbackPublicRoute = new Elysia({ prefix: "/public" }).post(
  "/feedback",
  async ({ body, request, server }) => {
    // The route schema requires `body` to be a string at runtime; a non-string
    // here means the schema was bypassed by a future refactor.
    if (typeof body !== "string") {
      panic("feedback intake body bypassed t.String schema");
    }
    return await receivePublicFeedback({
      rawBody: body,
      clientIp: resolveClientIp(request, server ?? null),
    });
  },
  {
    body: t.String({ maxLength: MAX_RAW_FEEDBACK_BODY_CHARS }),
    parse: "text",
  },
);

export const feedbackRoute = new Elysia({ prefix: "/v1/feedback" })
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/", createFeedbackReport.handler, {
    body: createFeedbackReport.config.body,
    permissions: createFeedbackReport.config.permissions,
  });
