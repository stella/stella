import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "mcp-web-handoff",
  capability: "Creating MCP result links for browser sign-in",
  owner: [
    "apps/api/src/lib/auth.ts",
    "apps/api/src/lib/auth/mcp-web-handoff.ts",
    "apps/api/src/lib/auth/mcp-web-handoff-service.ts",
    "apps/api/src/lib/auth/mcp-web-handoff-plugin.ts",
    "apps/api/src/lib/auth/mcp-web-handoff-session.ts",
  ],
  summary:
    "The authentication owner supplies database and budget handles to the " +
    "handoff service and browser endpoint. MCP result decoration calls its " +
    "mint operation without acquiring a database connection.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/auth"],
    names: ["mintWebHandoff"],
    allowed: [
      {
        path: "apps/api/src/mcp/web-handoff-links.ts",
        reason: "Decorates eligible MCP result links through the mint owner.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
