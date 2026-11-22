#!/usr/bin/env bun
/**
 * Runs the API's lint command once per shard of the API tree, one shard after
 * another: `bun apps/api/scripts/lint-shards.ts <lint command without paths>`
 * (the API's `lint` script passes `bun scripts/lint.ts`).
 *
 * One process over the whole API keeps the oxlint process's memory resident
 * while tsgolint type-checks every file. On a 16 GiB CI runner the two
 * together left under 1 GiB free, and without `GOMEMLIMIT` the runner was
 * stopped. tsgolint's peak follows the files one process checks (about 11 GiB
 * for the whole API, under 7 GiB for the largest shard), so separate processes
 * keep each one well inside the runner, in about the same total time.
 *
 * When `API_LINT_SHARD` is set to `lib`, `handlers`, or `rest`, only that
 * shard runs so CI can fan the three shards across parallel runners.
 *
 * The last shard lints everything the earlier shards leave out, so a new
 * directory is linted without being listed here.
 */
export const API_LINT_SHARDS = [
  "apps/api/src/lib",
  "apps/api/src/handlers",
] as const;

export const API_LINT_SHARD_NAMES = ["lib", "handlers", "rest"] as const;
export type ApiLintShard = (typeof API_LINT_SHARD_NAMES)[number];

export const isApiLintShard = (value: string): value is ApiLintShard =>
  API_LINT_SHARD_NAMES.some((name) => name === value);

/** The commands that together lint every API file exactly once. */
export const apiLintCommands = (oxlint: readonly string[]): string[][] => [
  ...API_LINT_SHARDS.map((shard) => [...oxlint, shard]),
  [
    ...oxlint,
    ...API_LINT_SHARDS.flatMap((shard) => ["--ignore-pattern", `${shard}/**`]),
    "apps/api",
  ],
];

/** The single command for a named shard (`lib`, `handlers`, or `rest`). */
export const apiLintCommandForShard = (
  oxlint: readonly string[],
  shard: ApiLintShard,
): string[] => {
  const commands = apiLintCommands(oxlint);
  switch (shard) {
    case "lib":
      return commands[0] ?? [];
    case "handlers":
      return commands[1] ?? [];
    case "rest":
      return commands[2] ?? [];
  }
};

if (import.meta.main) {
  const oxlint = process.argv.slice(2);
  if (oxlint.length === 0) {
    console.error("usage: lint-shards.ts <lint command without paths>");
    process.exit(2);
  }
  const requestedShard = process.env["API_LINT_SHARD"]?.trim();
  let commands: string[][];
  if (requestedShard !== undefined && requestedShard !== "") {
    if (!isApiLintShard(requestedShard)) {
      console.error(
        `unknown API_LINT_SHARD "${requestedShard}"; expected one of ${API_LINT_SHARD_NAMES.join(", ")}`,
      );
      process.exit(2);
    }
    commands = [apiLintCommandForShard(oxlint, requestedShard)];
  } else {
    commands = apiLintCommands(oxlint);
  }
  let failed = false;
  for (const command of commands) {
    console.log(`$ ${command.join(" ")}`);
    const result = Bun.spawnSync(command, {
      stdio: ["inherit", "inherit", "inherit"],
    });
    // Every shard runs, so one run reports the findings of all of them.
    failed ||= !result.success;
  }
  process.exit(failed ? 1 : 0);
}
