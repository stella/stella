import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "court-filter",
  capability: "Court-tier filter rows and selection",
  owner: ["packages/ui/src/components/court-filter.tsx"],
  summary:
    "The web case-law index and MCP search app share CourtFilter. The caller " +
    "owns localized labels and single or multiple selection; the component " +
    "owns searchable court rows, tier selection, and checkbox state. MCP " +
    "reader bundles reject local definitions of shared UI components through " +
    "the existing rendered component graph guard.",
  enforcement: {
    kind: "custom-rule",
    rule: "mcp-reader-ui",
    reason:
      "The build guard discovers shared UI exports and rejects duplicate component definitions in reachable MCP app modules.",
  },
} as const satisfies OwnershipEntry;
