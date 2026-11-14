import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-link-icon-bytes",
  capability: "Reading authenticated link icon bytes for visible reply links",
  owner: ["apps/web/src/features/chat/link-icons.ts"],
  summary:
    "The web adapter deduplicates authenticated requests by hostname. Visible reply links retry temporary responses with bounded backoff and retain local blob URLs until disposal; composer and restricted hosts keep bundled icons.",
  enforcement: {
    // The browser reaches the icons through the `link-icons` path segment of
    // the API client (`api.chat["link-icons"]`).
    kind: "literal-pattern",
    pattern: "^link-icons$",
    allowed: [
      {
        path: "apps/api/src/handlers/chat/link-icons/",
        reason:
          "The API's icon cache names its own coordination scope, not a client path.",
      },
      {
        path: "apps/api/src/lib/redis-keys.ts",
        reason: "The key registry lists the icon cache's scope.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
