import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "personal-api-key-policy-reader",
  capability: "Reading personal API key policy during credential verification",
  owner: ["apps/api/src/lib/machine-api-keys/personal-policy-reader.ts"],
  summary:
    "The MCP authentication boundary can read policy without importing lifecycle mutations.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/machine-api-keys/personal-policy-reader"],
    allowed: [
      {
        path: "apps/api/src/mcp/api-key-auth.ts",
        reason: "Checks policy before accepting a personal credential.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
