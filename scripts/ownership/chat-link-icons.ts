import { LINK_ICON_TRANSPORT_OWNERS } from "../outbound-transport-census.ts";
import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-link-icons",
  capability: "Fetching and caching verified chat link icon bytes",
  owner: LINK_ICON_TRANSPORT_OWNERS.map(({ path }) => path),
  summary:
    "An authenticated direct request grants outbound authority. Every origin hop uses the shared DNS-validating, socket-pinned byte transport. Bounded PNG and ICO bytes use ephemeral, budgeted Valkey storage; stored misses return no-icon, while temporary origin or coordination failures remain retryable and uncacheable.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/handlers/chat/link-icons/origin"],
    names: ["createExactIconOrigin", "createLinkIconOrigin"],
    allowed: [
      {
        path: "apps/api/src/handlers/chat/link-icons/get-exact.ts",
        reason:
          "Authenticated request boundary supplying issued outbound authority.",
      },
      {
        path: "apps/api/src/handlers/chat/link-icons/get.ts",
        reason:
          "Authenticated request boundary supplying issued outbound authority.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
