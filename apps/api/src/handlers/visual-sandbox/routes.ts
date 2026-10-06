import type { Context } from "elysia";

import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import { env } from "@/api/env";
import { frontendOrigins } from "@/api/lib/dev-origins";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import { runtimeMode } from "@/api/runtime-mode";

import { visualOuterDocument, visualOuterPolicy } from "./document";

const origins = frontendOrigins({
  frontendUrl: env.FRONTEND_URL,
  runtimeMode: runtimeMode(),
}).map((origin) => new URL(origin).origin);
const document = visualOuterDocument(origins);
const policy = visualOuterPolicy(origins);

export const handleVisualSandboxRequest = (
  request: Request,
  set: Context["set"],
): Response | undefined => {
  if (
    request.method !== "GET" ||
    new URL(request.url).pathname !== VISUAL_SANDBOX_PATH
  ) {
    return undefined;
  }
  delete set.headers["X-Frame-Options"];
  delete set.headers["Content-Security-Policy"];
  return new Response(document, {
    headers: {
      [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
      "Content-Security-Policy": policy,
      "Content-Type": "text/html; charset=utf-8",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
    },
  });
};
