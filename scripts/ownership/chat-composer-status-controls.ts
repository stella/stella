import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-composer-status-controls",
  capability: "Chat composer web-search, anonymization, and context controls",
  owner: ["apps/web/src/components/chat/chat-composer-dock.tsx"],
  summary:
    "The dock is the only assembler of the known globe, shield, and context " +
    "controls. Its typed pending branch disables those real controls instead " +
    "of substituting lookalike skeleton blocks.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/components/chat/chat-context-meter",
      "@/features/chat/components/chat-anonymized-toggle",
      "@/features/chat/components/chat-web-search-toggle",
    ],
    names: ["ChatAnonymizedToggle", "ChatContextMeter", "ChatWebSearchToggle"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
