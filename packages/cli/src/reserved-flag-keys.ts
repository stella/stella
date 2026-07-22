/** Parser keys reserved for CLI-wide behavior rather than tool input fields. */
export const RESERVED_FLAG_KEYS = {
  input: "input",
  output: "output",
  json: "json",
  table: "table",
  cursor: "cursor",
  limit: "limit",
  all: "all",
  yes: "yes",
  /** Never prompt; fail closed where a prompt would be needed. */
  noInput: "noInput",
  /** Capability leaves only: validate server-side without executing. */
  dryRun: "dryRun",
} as const;
