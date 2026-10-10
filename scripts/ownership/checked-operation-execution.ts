import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "checked-operation-execution",
  capability: "Executing checked scoped operations",
  owner: [
    "apps/api/src/lib/api-handlers.ts",
    "apps/api/src/lib/rate-limit/action-admission.ts",
    "apps/api/src/lib/ai-config-loader.ts",
    "apps/api/src/lib/files/organization-file-usage.ts",
    "apps/api/src/handlers/chat/tools/spawn-subagents-tool.ts",
  ],
  summary:
    "Checking owners enter the proof-required execution boundary after admission. Other callers use the owning admission API.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/api-handlers",
      "@/api/lib/rate-limit/action-admission",
      "@/api/lib/ai-config-loader",
      "@/api/lib/files/organization-file-usage",
      "@/api/handlers/chat/tools/spawn-subagents-tool",
    ],
    names: [
      "runCheckedScopedHandler",
      "runCheckedAction",
      "readCheckedAIConfiguration",
      "runCheckedOrganizationFileWrite",
      "runCheckedOrganizationFileCopy",
      "runCheckedSubagentBatch",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/safe-handler-factories.type-test.ts",
        reason:
          "Reads the module's export names at type level to bind the factory map; calls nothing.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
