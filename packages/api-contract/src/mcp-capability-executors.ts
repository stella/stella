/** Capability dispatch uses one executor for each catalog access class. */
export const MCP_CAPABILITY_EXECUTORS = {
  read: "read_capability",
  write: "write_capability",
} as const satisfies Record<"read" | "write", string>;

export type McpCapabilityExecutor =
  (typeof MCP_CAPABILITY_EXECUTORS)[keyof typeof MCP_CAPABILITY_EXECUTORS];
