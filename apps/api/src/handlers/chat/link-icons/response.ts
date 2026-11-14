import { panic } from "better-result";

import type { LinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import type { CachePolicy } from "@/api/http/cache";
import type { ResponseSet } from "@/api/http/context";

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

/** An icon answer: browsers keep a found or missing icon, never a failure. */
export const linkIconBody = (outcome: LinkIconOutcome, set: ResponseSet) => {
  set.headers["X-Content-Type-Options"] = "nosniff";
  set.cache = BROWSER_CACHE[outcome.type];
  return serializeLinkIcon(outcome);
};
