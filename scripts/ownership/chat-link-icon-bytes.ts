import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-link-icon-bytes",
  capability: "Reading authenticated link icon bytes for visible reply links",
  owner: ["apps/web/src/features/chat/link-icons.ts"],
  summary:
    "The web adapter deduplicates authenticated requests by hostname. Visible reply links retain local blob URLs until disposal; composer and restricted hosts keep bundled icons.",
  enforcement: {
    kind: "import",
    specifiers: ["@/lib/api", "@/lib/eden-client"],
    names: ["linkIconsApi"],
    allowed: [
      {
        path: "apps/web/src/lib/api.ts",
        reason:
          "The canonical API import surface re-exports the configured Eden icon client.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
