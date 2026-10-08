import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "document-identity",
  capability: "Statute and decision identity badges",
  owner: ["packages/ui/src/components/document-identity-badge.tsx"],
  summary:
    "Document lists and rails render statute numbers, court chips and unknown " +
    "document marks through DocumentIdentityBadge. The existing CourtBadge " +
    "is the decision variant; its raw primitive is confined to this owner. " +
    "Matter colours remain owned by MatterIcon. The document identity guard " +
    "discovers document row and rail renderers and checks their rendered component graph.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@stll/ui/court-badge",
      "packages/ui/src/components/court-badge",
    ],
    names: ["CourtBadge"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
