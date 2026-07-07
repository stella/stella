/**
 * Public feedback intake route (`POST /public/feedback`).
 *
 * Deliberately mounted OUTSIDE the auth macro: the caller may have no Stella
 * account at all (that is the whole reason the intake exists). Its protection
 * is the strict body validation plus the per-IP rate limit and content dedup
 * enforced inside `receivePublicFeedback`, not identity.
 *
 * `parse: "text"` hands the handler the raw body string: Elysia's normalizer
 * would strip unknown keys before a typed schema could reject them, so the
 * strict "reject anything else" contract runs on the raw payload in the handler
 * (Valibot `strictObject`), the same shape as the hosted-usage webhook. The
 * route keeps only a coarse size cap as defense-in-depth before parsing.
 */

import { panic } from "better-result";
import Elysia, { t } from "elysia";

import {
  MAX_RAW_FEEDBACK_BODY_CHARS,
  receivePublicFeedback,
} from "@/api/handlers/feedback/intake";
import { resolveClientIp } from "@/api/lib/client-ip";

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
