import { panic } from "better-result";

export const median = (values: readonly number[]) => {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return panic("Query perf median requires nonnegative finite samples");
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle);
  if (upper === undefined) {
    return panic("Query perf median missing sample");
  }
  if (sorted.length % 2 !== 0) {
    return upper;
  }
  const lower = sorted.at(middle - 1);
  return lower === undefined
    ? panic("Query perf median missing sample")
    : (lower + upper) / 2;
};

/**
 * Wall time on a shared runner jitters, and the scaled-time check multiplies
 * it by the fixture scale factor. One sample over the allowance is therefore
 * not a finding by itself: the statement is sampled until this many samples
 * exist, and their median decides. A sample within the allowance needs no
 * confirmation, so statements that pass cost one execution.
 */
export const QUERY_PERF_TIME_CONFIRMATION_SAMPLES = 3;

/**
 * The execution times that decide a statement's scaled-time check. `resample`
 * receives `last: true` for the final confirmation sample, so a caller whose
 * statement must leave its effects behind keeps that one and rolls back the
 * others.
 */
export const confirmedExecutionTimes = async ({
  first,
  overAllowance,
  resample,
}: {
  first: number;
  overAllowance: (executionTimeMs: number) => boolean;
  resample: (last: boolean) => Promise<number>;
}) => {
  const times = [first];
  if (!overAllowance(first)) {
    return times;
  }
  while (times.length < QUERY_PERF_TIME_CONFIRMATION_SAMPLES) {
    // db-await-in-loop: confirmation samples run one at a time; concurrency would distort the timing they confirm.
    times.push(
      await resample(times.length + 1 === QUERY_PERF_TIME_CONFIRMATION_SAMPLES),
    );
  }
  return times;
};
