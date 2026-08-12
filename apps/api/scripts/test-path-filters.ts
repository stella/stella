/**
 * Path-shaped CLI arguments select which discovered test files to run.
 *
 * They must never be appended to the batches the runner builds. Appending adds
 * the file to EVERY batch, including batches deliberately built to keep it away
 * from a test that mocks a module it imports, which is the isolation the
 * batcher exists to provide (see src/tests/module-mock-batching.ts). A local
 * run would then fail, or pass, for reasons CI never reproduces.
 *
 * So a path filter narrows each batch instead of joining it: composition is
 * decided by the batcher over every discovered file, and the filter only picks
 * which of those files run.
 */

/**
 * Whether an argument selects test files rather than configuring bun.
 *
 * Deliberately narrow: a flag and its value (`-t`, `--bail 2`) must reach bun
 * untouched, so only an argument that looks like a path counts.
 */
export const isTestPathFilter = (argument: string): boolean =>
  !argument.startsWith("-") &&
  (argument.includes("/") ||
    argument.endsWith(".ts") ||
    argument.endsWith(".tsx"));

export type PartitionedArguments = {
  /** Arguments handed to bun unchanged. */
  bunArguments: string[];
  /** Path-shaped arguments selecting which discovered files run. */
  pathFilters: string[];
};

export const partitionRunnerArguments = (
  runnerArguments: readonly string[],
): PartitionedArguments => {
  const bunArguments: string[] = [];
  const pathFilters: string[] = [];
  for (const argument of runnerArguments) {
    if (isTestPathFilter(argument)) {
      pathFilters.push(argument);
      continue;
    }
    bunArguments.push(argument);
  }
  return { bunArguments, pathFilters };
};

const LEADING_RELATIVE_PREFIX = /^\.?\//u;

/**
 * The discovered paths a filter set selects, matched by substring the way bun
 * matches a bare path argument. `null` means no filter was given, which the
 * caller reads as "run every file in the batch".
 */
export const selectTestPaths = (
  testPaths: readonly string[],
  pathFilters: readonly string[],
): ReadonlySet<string> | null => {
  if (pathFilters.length === 0) {
    return null;
  }
  const normalized = pathFilters.map((filter) =>
    filter.replace(LEADING_RELATIVE_PREFIX, ""),
  );
  return new Set(
    testPaths.filter((testPath) =>
      normalized.some((filter) => testPath.includes(filter)),
    ),
  );
};
