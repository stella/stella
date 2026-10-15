import type { Context } from "elysia";

import type { LinkIcon } from "@/api/handlers/chat/link-icons/origin";
import { applyResponseCachePolicy } from "@/api/lib/security-headers";

const BROWSER_CACHE_SECONDS = 3600;

export const linkIconBody = (icon: LinkIcon | null, set: Context["set"]) => {
  Object.assign(set.headers, {
    "X-Content-Type-Options": "nosniff",
  });
  const response = icon
    ? new Blob([new Uint8Array(icon.bytes)], { type: icon.mime })
    : ({ type: "no-icon" } as const);
  applyResponseCachePolicy({
    cache: { kind: "private", maxAge: BROWSER_CACHE_SECONDS },
    response,
    set,
  });
  return response;
};
