import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-amendments",
  capability:
    "Persisting and reading publisher-stated provision amendment effects",
  owner: ["apps/api/src/lib/legal-search/legislation-amendments.ts"],
  summary:
    "The owner replaces work-scoped publisher snapshots atomically and pages " +
    "incoming and outgoing effects by publisher identity. Readers share it " +
    "rather than inferring amending acts from consolidation dates.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
