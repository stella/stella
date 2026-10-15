import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "entity-sibling-naming",
  capability: "Resolving names for new sibling entities",
  owner: [
    "apps/api/src/lib/entities/sibling-name.ts",
    "apps/api/src/lib/entities/sibling-name-insert.ts",
  ],
  summary:
    "The insert owner reads current matter and parent names, reserves pending batch names, and supplies a resolved display name plus a derived sanitized file name to single and batch inserts. The existing typed extraction-file selector identifies each current version's primary file; secondary attachment names remain independent. The pure producer is confined to that owner so callers cannot substitute an empty sibling set.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/entities/sibling-name"],
    names: ["resolveSiblingName"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
