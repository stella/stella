import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "work-admission",
  capability: "Admitting process-bound work",
  owner: ["apps/api/src/lib/load/work-admission.ts"],
  summary:
    "Memory-heavy work carries a short-lived admission proof from a named process pool. Only the current consumers may mint proofs.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/load/work-admission"],
    names: ["admitWork"],
    allowed: [
      {
        path: "apps/api/src/lib/files/office-evidence.ts",
        reason: "Office evidence extraction holds the heavy-sidecar pool.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
