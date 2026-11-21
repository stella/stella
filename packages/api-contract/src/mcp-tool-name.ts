// Acceptance admits a 64-character skill slug plus its namespace. This
// first-party grammar is a subset of MCP's 1–128 ASCII-character guidance;
// server emission retains its separate compatibility budget.
export const MCP_TOOL_NAME_MAX_LENGTH = 71;
export const MCP_TOOL_NAME_PATTERN: RegExp = new RegExp(
  `^[a-z][a-z0-9_-]{0,${MCP_TOOL_NAME_MAX_LENGTH - 1}}$`,
  "u",
);
