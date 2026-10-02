// Shared pure guardrails used while generating command trees.

/** Reserved top-level command names a generated domain may never take (spec S1). */
export const RESERVED_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([
  "auth",
  "compatibility",
  "tools",
  "reference",
  "upload",
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
  "--no-input",
  "--schema",
  "--verbose",
  "--file",
  "--dry-run",
  "--yes",
  "-y",
  "--all",
  "--cursor",
  "--limit",
  "--org",
  "--server",
  "--help",
  "-h",
  "--version",
]);
