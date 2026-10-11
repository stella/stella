import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "conditional-operation-predicates",
  capability: "Checking conditional operation prerequisites",
  owner: [
    "apps/api/src/handlers/chat/get-suggested-prompts.ts",
    "apps/api/src/handlers/chat/send-message.ts",
    "apps/api/src/handlers/chat/suggest-thread-title.ts",
    "apps/api/src/handlers/chat/tools/template-tools.ts",
    "apps/api/src/handlers/document-reviews/create-run.ts",
    "apps/api/src/handlers/document-reviews/parties.ts",
    "apps/api/src/handlers/document-reviews/prepare-proposal.ts",
    "apps/api/src/handlers/document-translations/runs/create.ts",
    "apps/api/src/handlers/flows/runs/start.ts",
    "apps/api/src/handlers/lists/verifications/create.ts",
    "apps/api/src/handlers/reports/report-export-queue.ts",
    "apps/api/src/handlers/templates/fills/create.ts",
    "apps/api/src/lib/templates/template-fill-usage.ts",
    "apps/api/src/lib/flows/start-flow-run.ts",
    "apps/api/src/mcp/template-tools.ts",
  ],
  summary:
    "Registered callers bind conditional execution to checked inputs. New callers join this ownership census before using the checking API.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/api-handlers"],
    names: ["authorizeHandlerUsage", "authorizeHandlerRunSize"],
    allowed: [
      {
        path: "apps/api/src/lib/safe-handler-factories.type-test.ts",
        reason:
          "Reads the module's export names at type level to bind the factory map; calls nothing.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
