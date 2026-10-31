import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "matter-reach-rule",
  capability: "Deciding which roles reach a matter without an assignment",
  owner: ["apps/api/src/lib/workspaces/visibility.ts"],
  summary:
    "The matter visibility module states the reach rule once, as a TypeScript check and as SQL predicates over any matter alias. Every other check, query and lock path asks it instead of comparing roles itself.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/permissions"],
    names: ["ORGANIZATION_MATTER_ADMIN_ROLES"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
