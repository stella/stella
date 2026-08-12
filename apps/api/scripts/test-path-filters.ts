/**
 * Positional arguments select which discovered test files to run.
 *
 * They must never be appended to the batches the runner builds. Appending adds
 * the file to EVERY batch, including batches deliberately built to keep it away
 * from a test that mocks a module it imports, which is the isolation the
 * batcher exists to provide (see src/tests/module-mock-batching.ts). A local
 * run would then fail, or pass, for reasons CI never reproduces.
 *
 * So a positional narrows each batch instead of joining it: composition is
 * decided by the batcher over every discovered file, and the positional only
 * picks which of those files run.
 *
 * Classification tracks option arity rather than guessing from the shape of a
 * string. Bun's own grammar is `bun test [flags] [...patterns]`, where a
 * pattern is matched against the file path as a substring, so `redis-outage`
 * is as much a pattern as `src/lib/redis-outage.test.ts`; and a value-taking
 * flag's value may look exactly like a path (`--reporter-outfile reports/api.xml`,
 * `-t "GET /workspaces"`) while belonging to bun.
 */

/** Flags whose value is the following argument, so it is never a pattern. */
const VALUE_FLAGS = new Set([
  "-c",
  "--concurrency",
  "--config",
  "--coverage-dir",
  "--coverage-reporter",
  "--cwd",
  "--env-file",
  "--max-concurrency",
  "--preload",
  "-r",
  "--reporter",
  "--reporter-outfile",
  "--rerun-each",
  "--shard",
  "-t",
  "--test-name-pattern",
  "--timeout",
]);

/**
 * Flags whose value is optional and numeric (`--bail`, `--bail 3`). Only a
 * bare integer is taken as the value, so `--bail some-pattern` still selects.
 */
const OPTIONAL_NUMERIC_FLAGS = new Set(["--bail"]);

const INTEGER_PATTERN = /^\d+$/u;
const FLAGS_TERMINATOR = "--";

export type PartitionedArguments = {
  /** Arguments handed to bun unchanged, values included. */
  bunArguments: string[];
  /** Positional patterns selecting which discovered files run. */
  patterns: string[];
};

export const partitionRunnerArguments = (
  runnerArguments: readonly string[],
): PartitionedArguments => {
  const bunArguments: string[] = [];
  const patterns: string[] = [];
  let onlyPatternsRemain = false;

  for (let index = 0; index < runnerArguments.length; index += 1) {
    const argument = runnerArguments[index] ?? "";

    if (onlyPatternsRemain) {
      patterns.push(argument);
      continue;
    }
    if (argument === FLAGS_TERMINATOR) {
      onlyPatternsRemain = true;
      bunArguments.push(argument);
      continue;
    }
    // `--flag=value` carries its value in the same token, so nothing follows.
    if (!argument.startsWith("-")) {
      patterns.push(argument);
      continue;
    }

    bunArguments.push(argument);
    const next = runnerArguments[index + 1];
    if (next === undefined) {
      continue;
    }
    const takesNext =
      VALUE_FLAGS.has(argument) ||
      (OPTIONAL_NUMERIC_FLAGS.has(argument) && INTEGER_PATTERN.test(next));
    if (takesNext) {
      bunArguments.push(next);
      index += 1;
    }
  }

  return { bunArguments, patterns };
};

const LEADING_RELATIVE_PREFIX = /^\.?\//u;

/**
 * The discovered paths a pattern set selects, matched as a substring of the
 * path the way bun matches a positional. `null` means no pattern was given,
 * which the caller reads as "run every file in the batch".
 */
export const selectTestPaths = (
  testPaths: readonly string[],
  patterns: readonly string[],
): ReadonlySet<string> | null => {
  if (patterns.length === 0) {
    return null;
  }
  const normalized = patterns.map((pattern) =>
    pattern.replace(LEADING_RELATIVE_PREFIX, ""),
  );
  return new Set(
    testPaths.filter((testPath) =>
      normalized.some((pattern) => testPath.includes(pattern)),
    ),
  );
};
