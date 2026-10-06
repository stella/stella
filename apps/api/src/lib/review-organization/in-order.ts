import { Result } from "better-result";

/**
 * Run `step` for each item, one after another, stopping at the first error.
 * The review organization's seed and reset write a handful of rows, each
 * through a shared handler that takes its own locks and caps; running them in
 * order keeps those locks uncontended and makes a failure stop the run where
 * it happened.
 */
export const inOrder = async <T, E>(
  items: Iterable<T>,
  step: (item: T) => Promise<Result<void, E>>,
): Promise<Result<void, E>> => {
  for (const item of items) {
    // db-await-in-loop: a bounded set of sample rows, each through its shared handler; sequential on purpose (see above)
    const outcome = await step(item);
    if (Result.isError(outcome)) {
      return outcome;
    }
  }
  return Result.ok(undefined);
};
