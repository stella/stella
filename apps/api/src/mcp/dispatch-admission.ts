export const MCP_DISPATCH_FAMILIES = [
  "static",
  "capability",
  "external_mcp",
  "skill",
] as const;

export type McpDispatchFamily = (typeof MCP_DISPATCH_FAMILIES)[number];

export const MCP_DISPATCH_ADMISSION = {
  static: "static-invocation",
  capability: "capability-executor",
  external_mcp: "gateway-after-authority",
  skill: "gateway-after-authority",
} as const satisfies Record<
  McpDispatchFamily,
  "static-invocation" | "capability-executor" | "gateway-after-authority"
>;
