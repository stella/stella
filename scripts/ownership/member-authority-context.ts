import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "member-authority-context",
  capability: "Building the authority a request context carries",
  owner: ["apps/api/src/lib/permission-authorization.ts"],
  summary:
    "Context builders construct opaque member authority once; handlers spend it through the permission owner.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/permission-authorization"],
    names: ["sessionMemberRole", "authorizedMemberRole"],
    allowed: [
      {
        path: "apps/api/src/lib/machine-api-keys/personal-lifecycle.ts",
        reason:
          "Builds the key owner authority from a locked live membership before minting.",
      },
      {
        path: "apps/api/src/lib/auth.ts",
        reason: "Builds the authenticated session context.",
      },
      {
        path: "apps/api/src/mcp/effective-authority.ts",
        reason: "Builds authority for the MCP request context.",
      },
      {
        path: "apps/api/src/mcp/api-key-auth.ts",
        reason:
          "Validates a credential's grants against its current membership.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/auth.ts",
        reason: "Builds the authenticated desktop account context.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/link-grants.ts",
        reason: "Builds the linked desktop account context.",
      },
      {
        path: "apps/api/scripts/ai-provider-canary-chat-toolsets.ts",
        reason:
          "Builds an owner session to assemble the full chat tool set for provider schema checks; serves no request.",
      },
      {
        path: "apps/api/src/lib/review-organization/reset.ts",
        reason:
          "Builds the restricted review account's authority from the sole membership the reset just proved, for the sample-data seed.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
