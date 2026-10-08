import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-composer-status-row",
  capability: "Chat composer status-row assembly and loading state",
  owner: ["apps/web/src/components/chat/chat-composer-dock.tsx"],
  summary:
    "ChatComposerDock owns the pending/ready discriminator and the canonical " +
    "control order, so loading keeps every known icon and fixed dimension " +
    "while only unresolved values render a skeleton.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/ui/composer"],
    names: ["ComposerStatusRow"],
    allowed: [
      {
        path: "apps/web/src/routes/law/-law-home/law-entry-box.tsx",
        reason:
          "The public-law entry box has its own non-chat jurisdiction and scope row.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
