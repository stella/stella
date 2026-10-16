import { panic } from "better-result";
import type { Context } from "elysia";

import type { LinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import { applyResponseCachePolicy } from "@/api/lib/security-headers";
import type { CachePolicy } from "@/api/lib/security-headers";

const BROWSER_CACHE_SECONDS = 3600;
const BROWSER_CACHE = {
  icon: { kind: "private", maxAge: BROWSER_CACHE_SECONDS },
  "no-icon": { kind: "private", maxAge: BROWSER_CACHE_SECONDS },
  temporary: { kind: "none" },
} as const satisfies Record<LinkIconOutcome["type"], CachePolicy>;

const serializeLinkIcon = (outcome: LinkIconOutcome) => {
  switch (outcome.type) {
    case "icon":
      return new Blob([new Uint8Array(outcome.icon.bytes)], {
        type: outcome.icon.mime,
      });
    case "no-icon":
    case "temporary":
      return outcome;
    default:
      outcome satisfies never;
      return panic("Unhandled link icon response outcome");
  }
};

export const linkIconBody = (outcome: LinkIconOutcome, set: Context["set"]) => {
  Object.assign(set.headers, { "X-Content-Type-Options": "nosniff" });
  const response = serializeLinkIcon(outcome);
  applyResponseCachePolicy({
    cache: BROWSER_CACHE[outcome.type],
    response,
    set,
  });
  return response;
};
