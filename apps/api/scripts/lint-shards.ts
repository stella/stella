#!/usr/bin/env bun
/**
 * Runs the API's oxlint command once per shard of the API tree, one shard after
 * another: `bun apps/api/scripts/lint-shards.ts <oxlint command without paths>`.
 *
 * One process over the whole API keeps the oxlint process's memory resident
 * while tsgolint type-checks every file. On a 16 GiB CI runner the two
 * together left under 1 GiB free, and without `GOMEMLIMIT` the runner was
 * stopped. tsgolint's peak follows the files one process checks (about 11 GiB
 * for the whole API, under 7 GiB for the largest shard), so separate processes
 * keep each one well inside the runner, in about the same total time.
 *
 * The last shard lints everything the earlier shards leave out, so a new
 * directory is linted without being listed here.
 */
export const API_LINT_SHARDS = [
  "apps/api/src/lib",
  "apps/api/src/handlers",
] as const;

/** The commands that together lint every API file exactly once. */
export const apiLintCommands = (oxlint: readonly string[]): string[][] => [
  ...API_LINT_SHARDS.map((shard) => [...oxlint, shard]),
  [
    ...oxlint,
    ...API_LINT_SHARDS.flatMap((shard) => ["--ignore-pattern", `${shard}/**`]),
    "apps/api",
  ],
];

if (import.meta.main) {
  const oxlint = process.argv.slice(2);
  if (oxlint.length === 0) {
    console.error("usage: lint-shards.ts <oxlint command without paths>");
    process.exit(2);
  }
  let failed = false;
  for (const command of apiLintCommands(oxlint)) {
    console.log(`$ ${command.join(" ")}`);
    const result = Bun.spawnSync(command, {
      stdio: ["inherit", "inherit", "inherit"],
    });
    // Every shard runs, so one run reports the findings of all of them.
    failed ||= !result.success;
  }
  process.exit(failed ? 1 : 0);
}
