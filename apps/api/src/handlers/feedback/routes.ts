/**
 * The two HTTP entry points into the feedback pipeline.
 *
 * `POST /public/feedback` takes no session: the caller may have no Stella
 * account at all, which is the whole reason the intake exists. Its protection
 * is the strict body validation plus the per-IP rate limit enforced inside
 * `receivePublicFeedback`, not identity. The route reads the raw body as text
 * so the intake's own typed schema can reject unknown keys; the route keeps
 * only a coarse size cap as defense in depth.
 *
 * `POST /v1/feedback` is the authenticated route the web and desktop apps use.
 */
import * as v from "valibot";

import createFeedbackReport from "@/api/handlers/feedback/create";
import {
  MAX_RAW_FEEDBACK_BODY_CHARS,
  receivePublicFeedback,
} from "@/api/handlers/feedback/intake";
import { routes } from "@/api/http/route";
import { resolveRateLimitClientAddress } from "@/api/lib/client-ip";
import { defineEndpoint } from "@/api/lib/endpoints";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

const publicFeedback = defineEndpoint.public(
  {
    body: v.pipe(v.string(), v.maxLength(MAX_RAW_FEEDBACK_BODY_CHARS)),
    bodyMode: "text",
  },
  async ({ body, request, server }) =>
    await receivePublicFeedback({
      rawBody: body,
      clientIp: resolveRateLimitClientAddress({ request, server }),
    }),
);

export const feedbackPublicRoute = routes(
  { "/feedback": { POST: publicFeedback } },
  { prefix: "/public" },
);

export const feedbackRoute = routes(
  { "/": { POST: createFeedbackReport } },
  {
    prefix: "/v1/feedback",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
