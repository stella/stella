import type fc from "fast-check";

/**
 * Shared fast-check configuration for the repo's property tests.
 *
 * Two CI concerns are centralized here so individual tests do not have to
 * repeat them (issue #83):
 *
 *  1. Longer nightly runtime. A dedicated nightly job runs the property
 *     tests in isolation with `PROPERTY_TEST_NUM_RUNS_FACTOR` set, scaling
 *     every test's `numRuns` by that factor. PR CI leaves it unset (factor 1),
 *     so day-to-day runs keep their fast, per-test budgets.
 *
 *  2. Reproducible failures. Under CI, fast-check runs in verbose mode so the
 *     run log carries the full list of shrunk failing values (not only the
 *     final counterexample). The seed + counterexample fast-check already
 *     prints on failure are enough to replay a failure locally with
 *     `fc.assert(prop, { seed, path })`.
 */

const NUM_RUNS_FACTOR_ENV = "PROPERTY_TEST_NUM_RUNS_FACTOR";

/** fast-check's own default when a property does not specify `numRuns`. */
const FAST_CHECK_DEFAULT_NUM_RUNS = 100;

const readNumRunsFactor = (raw: string | undefined): number => {
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number(raw);
  // A factor below 1 (or non-numeric) would silently weaken nightly coverage;
  // fall back to the neutral factor instead.
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
};

// Treat the common CI values as enabled, but honor an explicit opt-out
// (`CI=false`/`0`) so verbose reporting can be silenced locally.
const isCi = (): boolean => {
  const raw = process.env["CI"];
  return raw !== undefined && raw !== "" && raw !== "false" && raw !== "0";
};

/**
 * Build the `fc.assert` parameters for a property test: pass the per-test
 * tuning you want in PR CI (typically just `numRuns`) and this scales it for
 * the nightly sweep and enables verbose reporting under CI.
 *
 * ```ts
 * fc.assert(fc.property(arb, predicate), propertyConfig({ numRuns: 200 }));
 * ```
 */
export const propertyConfig = <Ts>(
  params: fc.Parameters<Ts> = {},
): fc.Parameters<Ts> => {
  const factor = readNumRunsFactor(process.env[NUM_RUNS_FACTOR_ENV]);
  const baseNumRuns = params.numRuns ?? FAST_CHECK_DEFAULT_NUM_RUNS;
  return {
    verbose: isCi(),
    ...params,
    numRuns: Math.ceil(baseNumRuns * factor),
  };
};

/**
 * Scale a per-test Bun timeout (ms) by the same nightly factor that scales
 * `numRuns`, so an expensive property whose run count grows ×N also gets ×N
 * wall-clock before it is killed. In PR CI (factor 1) the timeout is unchanged.
 *
 * ```ts
 * test("round-trip", () => { ... }, propertyTestTimeout(15_000));
 * ```
 */
export const propertyTestTimeout = (baseMs: number): number =>
  Math.ceil(baseMs * readNumRunsFactor(process.env[NUM_RUNS_FACTOR_ENV]));
