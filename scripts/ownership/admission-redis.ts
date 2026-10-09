import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "admission-redis",
  capability: "Non-evicting admission coordination",
  owner: [
    "apps/api/src/lib/admission-redis.ts",
    "apps/api/src/lib/non-evicting-redis.ts",
  ],
  summary:
    "Admission, reservations, and fences use a checked command facade. A reported evicting policy refuses work; uninspectable policies warn. These callers cannot import the unchecked connection factory.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/admission-redis"],
    allowed: [
      {
        path: "apps/api/src/lib/rate-limit/action-admission.ts",
        reason:
          "Shared concurrency leases, period reservations, and service budgets.",
      },
      {
        path: "apps/api/src/lib/rate-limit/mcp-read-fence.ts",
        reason: "Shared emitted-byte windows and cancellation fences.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/publisher-request-gate.ts",
        reason: "Shared publisher pacing reservations and cooldowns.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
