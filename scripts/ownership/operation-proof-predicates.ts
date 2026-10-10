import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "operation-proof-predicates",
  capability: "Authorizing checked operation continuations",
  owner: [
    "apps/api/src/lib/api-handlers.ts",
    "apps/api/src/lib/templates/template-fill-usage.ts",
    "apps/api/src/lib/rate-limit/action-admission.ts",
    "apps/api/src/lib/ai-config-loader.ts",
    "apps/api/src/lib/files/organization-file-usage.ts",
    "apps/api/src/handlers/chat/tools/spawn-subagents-tool.ts",
  ],
  summary:
    "Checking owners authorize an operation over its complete input. The shared proof core keeps the named input and evidence together for execution after short reads settle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/proofs/checked-transaction"],
    names: ["authorizeOperation", "withAdmittedOperation"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
