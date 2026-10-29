import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "ai-config-decrypt",
  capability: "Organization AI settings decryption",
  owner: ["apps/api/src/lib/ai-config-crypto.ts"],
  summary:
    "Decrypted provider credentials stay behind the runtime settings readers and settings editing handlers; tests may exercise the boundary directly.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/ai-config-crypto"],
    names: [
      "decryptAIConfig",
      "unreadableOrgAIConfig",
      "OrgAIConfigReadError",
      "OrgAIConfigReadFailure",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/ai-config-loader.ts",
        reason:
          "Runtime organization settings loaders decrypt stored provider configuration.",
      },
      {
        path: "apps/api/src/lib/ai-config-loader-core.ts",
        reason:
          "The shared loader core classifies decryption failures without exposing their contents.",
      },
      {
        path: "apps/api/src/handlers/organization-settings/read-ai-config.ts",
        reason:
          "The settings read handler returns a masked view of decrypted provider configuration.",
      },
      {
        path: "apps/api/src/handlers/organization-settings/update-ai-config.ts",
        reason:
          "The settings update handler decrypts the current value before merging an edit.",
      },
      {
        path: "apps/api/src/lib/ai-config-loader.test.ts",
        reason:
          "Confidentiality tests exercise every runtime loader and classified failure.",
      },
      {
        path: "apps/api/src/lib/ai-config-crypto.test.ts",
        reason:
          "Unit tests exercise the decryption boundary and its failure classifications.",
      },
      {
        path: "apps/api/src/handlers/organization-settings/ai-config-decrypt-failure.test.ts",
        reason:
          "Confidentiality tests exercise both settings editing handlers.",
      },
      {
        path: "apps/api/src/handlers/organization-settings/update-ai-config.test.ts",
        reason:
          "Handler tests decrypt the stored result to verify the persisted edit.",
      },
      {
        path: "apps/api/src/tests/helpers/settings-failure-confidentiality.ts",
        reason:
          "The shared test assertion accepts only the content-free failure classification.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
