import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import { env } from "@/api/env";
import { routes } from "@/api/http/route";
import { frontendOrigins } from "@/api/lib/dev-origins";
import { defineEndpoint } from "@/api/lib/endpoints";
import { EMBEDDABLE_FRAME_HEADERS } from "@/api/lib/security-headers";
import { runtimeMode } from "@/api/runtime-mode";

import { visualOuterDocument, visualOuterPolicy } from "./document";

const origins = frontendOrigins({
  frontendUrl: env.FRONTEND_URL,
  runtimeMode: runtimeMode(),
}).map((origin) => new URL(origin).origin);
const document = visualOuterDocument(origins);
const policy = visualOuterPolicy(origins);

/** The outer visual sandbox document; its policy names who may frame it. */
const visualSandboxDocument = defineEndpoint.public(
  {},
  () =>
    new Response(document, {
      headers: {
        "Content-Security-Policy": policy,
        "Content-Type": "text/html; charset=utf-8",
        ...EMBEDDABLE_FRAME_HEADERS,
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-DNS-Prefetch-Control": "off",
      },
    }),
);

export const visualSandboxRoute = routes({
  [VISUAL_SANDBOX_PATH]: { GET: visualSandboxDocument },
});
