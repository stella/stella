// Shared generated-route guardrails plus the generated CLI annotation record.
// The annotation source of truth is API-owned (`apps/api/src/mcp/static-cli-metadata.ts`);
// `bun run codegen` projects it into `generated/tool-annotations.ts`.

/** Reserved top-level command names a generated domain may never take (spec S1). */
export const RESERVED_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([
  "auth",
  "tools",
  "reference",
  "help",
  "version",
  "completion",
  "config",
]);

/** Reserved global flags a generated per-tool flag may never collide with (spec S1). */
export const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  "--output",
  "--json",
  "--table",
  "--input",
  "--yes",
  "-y",
  "--all",
  "--cursor",
  "--limit",
  "--org",
  "--no-keychain",
  "--server",
  "--help",
  "-h",
  "--version",
]);

export { generatedToolAnnotations as TOOL_ANNOTATIONS } from "./generated/tool-annotations.js";
