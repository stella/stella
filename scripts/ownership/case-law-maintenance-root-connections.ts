import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "case-law-maintenance-root-connections",
  capability: "Opening case-law operator write and read-only connections",
  owner: ["apps/api/src/lib/case-law/maintenance-lane.ts"],
  summary:
    "enterCaseLawMaintenanceLane checks the database login posture and hands " +
    "operator scripts write-capable handles under the maintenance and corpus " +
    "schema lanes. openCaseLawReadOnlySession uses the same login check, " +
    "enforces READ ONLY on both handles and preserves the ingestion role " +
    "without entering a writer lane, so callers can choose snapshot isolation " +
    "before their first read. Scripts obtain connections through these doors " +
    "rather than importing the owner pools.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/case-law/maintenance-lane"],
    names: ["enterCaseLawMaintenanceLane", "openCaseLawReadOnlySession"],
    allowed: [
      {
        path: "apps/api/src/scripts/",
        reason: "Operator corpus commands choose a write or read-only door.",
      },
      {
        path: "apps/api/scripts/",
        reason: "Corpus seed and inspection commands use the operator doors.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
