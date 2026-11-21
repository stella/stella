import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "mcp-output-contracts",
  capability:
    "Binding first-party MCP handler results to structured content and advertised output schemas",
  owner: [
    "apps/api/src/mcp/tool-types.ts",
    "apps/api/src/mcp/tool-utils.ts",
    "apps/api/src/mcp/valibot-tool-definition.ts",
    "apps/api/src/mcp/static-tool-definitions.ts",
    "apps/api/src/mcp/gateway/dynamic-tool-policy.ts",
    "apps/api/src/mcp/gateway/list-tools.ts",
    "apps/api/src/mcp/tools.ts",
  ],
  summary:
    "Each static tool set supplies one Valibot output contract per handler, " +
    "and each Stella-owned dynamic tool family (skills) one shared contract " +
    "in its family policy. The shared factory derives the JSON Schema shown " +
    "in tools/list, the tool-set type binds it to the handler result, and " +
    "dispatch validates the post-egress projection before serving " +
    "structuredContent. Third-party connector tools keep their upstream " +
    "contract and are relayed as text. Explicit projectors keep dynamic " +
    "results compact without changing legacy text output.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
