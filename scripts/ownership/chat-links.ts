import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-links",
  capability: "External chat link detection and inline link presentation",
  owner: [
    "packages/chat/src/link.tsx",
    "packages/chat/src/link-detection.ts",
    "packages/chat/src/link-editor.ts",
    "packages/chat/src/link-markdown.ts",
  ],
  summary:
    "ChatLink owns external chat anchors, bundled site marks and the icon-source seam. " +
    "Composer adapters use the shared detector; markdown adapters classify legal and " +
    "reference citations before delegating external links. No chat surface fetches a third-party favicon.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-ad-hoc-chat-link/no-ad-hoc-chat-link",
    reason:
      "Content renderers reject independent external anchors and browser favicon URLs; specialized legal navigation and attachment links retain their own presentation.",
  },
} as const satisfies OwnershipEntry;
