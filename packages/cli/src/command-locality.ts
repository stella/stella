// Startup decides whether to keep the per-origin registry cache current before
// dispatching (spec 051 S5.3). The `tools/list` round-trip only earns its cost
// when the invoked command actually consumes the server-derived command tree.
// The hand-wired top-level routes (`auth`, `compatibility`, `tools`) and the
// global `--help`/`--version` flags run entirely from local state, so they must
// never pay a network call; only the generated domain commands and the
// `reference` resource commands read the registry and warrant a refresh.

/**
 * Top-level routes that run without any server-derived registry data. Every
 * other top-level command (the generated domain routes plus `reference`)
 * consumes the command tree and therefore benefits from a fresh cache.
 */
export const LOCAL_COMMAND_ROUTES: ReadonlySet<string> = new Set([
  "auth",
  "compatibility",
  "tools",
]);

/**
 * Whether the invoked command needs the server registry (and so warrants a
 * startup cache refresh). A root invocation (help), a leading global flag
 * (`--help`, `--version`), and the local routes above all resolve to `false`
 * so purely local commands never round-trip to the server.
 */
export const commandNeedsRegistry = (argv: readonly string[]): boolean => {
  const first = argv.at(0);
  if (first === undefined || first.startsWith("-")) {
    return false;
  }
  return !LOCAL_COMMAND_ROUTES.has(first);
};
