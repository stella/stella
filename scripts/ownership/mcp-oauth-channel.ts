import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "mcp-oauth-channel",
  capability: "Correlating connector authorization window outcomes",
  owner: [
    "apps/web/src/lib/mcp-oauth-channel.ts",
    "apps/web/src/lib/mcp-oauth-channel.dom.test.tsx",
  ],
  summary:
    "The channel owner creates a nonce per window, consumes each correlated outcome once, and notifies request callbacks before connection observers. A separate notification refreshes authenticated connection data across tabs. Only the owner and its protocol tests name the raw channel or wire discriminator.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "^(stll\\.)?mcp-oauth(-refresh)?$",
    allowed: [],
  },
} as const satisfies OwnershipEntry;
