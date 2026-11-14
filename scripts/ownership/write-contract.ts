import type { OwnershipEntry } from "../ownership-types";

export default {
  id: "write-contract",
  capability: "Declaring whole-value replacement preconditions",
  owner: [
    "apps/api/src/lib/write-contract/write-contract.ts",
    "apps/api/src/lib/write-contract/raw-write-contracts.ts",
  ],
  summary:
    "Safe factories require a patch or replace declaration. Replacement schemas " +
    "require every declared precondition field in every alternative. The route " +
    "census binds deferred declarations to exact reasoned migration identities " +
    "and prevents new or growing debt. Custom transports declare their contract " +
    "in the owner's route-keyed list without changing handler identities.",
  enforcement: {
    kind: "function-call",
    name: "recordWriteContract",
    within: ["apps/api/src/"],
    allowed: [
      {
        path: "apps/api/src/lib/api-handlers.ts",
        reason:
          "The safe factories register each constructed handler at their shared boundary.",
      },
      {
        path: "apps/api/src/lib/write-contract/write-contract.test.ts",
        reason:
          "Exercises schema rejection and handler identity registration with synthetic inputs.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
