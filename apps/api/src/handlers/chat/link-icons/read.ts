import { panic } from "better-result";

import type { createLinkIconCache } from "@/api/handlers/chat/link-icons/cache";
import type { LinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import type { SafeId } from "@/api/lib/branded-types";

type ReadLinkIconOptions = {
  hostname: string;
  userId: SafeId<"user">;
  ip: string;
  cache: Pick<ReturnType<typeof createLinkIconCache>, "readOrLease" | "store">;
  readOrigin: (hostname: string) => Promise<LinkIconOutcome>;
};

export const readLinkIcon = async ({
  hostname,
  userId,
  ip,
  cache,
  readOrigin,
}: ReadLinkIconOptions): Promise<LinkIconOutcome> => {
  const cached = await cache.readOrLease({ hostname, userId, ip });
  switch (cached.type) {
    case "icon":
    case "no-icon":
    case "temporary":
      return cached;
    case "lease": {
      const fetched = await readOrigin(hostname);
      switch (fetched.type) {
        case "temporary":
          // Keep only the short coordination lease, never a negative entry.
          return fetched;
        case "icon":
        case "no-icon": {
          const stored = await cache.store({
            hostname,
            token: cached.token,
            outcome: fetched,
          });
          return stored ? fetched : { type: "temporary" };
        }
        default:
          fetched satisfies never;
          return panic("Unhandled link icon origin outcome");
      }
    }
    default:
      cached satisfies never;
      return panic("Unhandled link icon cache state");
  }
};
