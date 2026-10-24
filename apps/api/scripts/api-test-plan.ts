// Every directory of this package that holds test files. `evals/` carries
// only its own colocated unit tests (e.g. `evals/lib/model-turn.test.ts`),
// never the eval scripts themselves, which call paid models and run on
// demand. A test file outside these roots never runs and nothing notices
// (the canary suites sat under `scripts/` unrun until the root was added), so
// the run fails when a visible directory outside them holds one.
export const TEST_ROOTS = ["src", "evals", "scripts"] as const;
const TEST_FILE_GLOB = `{${TEST_ROOTS.join(",")}}/**/*.test.{ts,tsx}`;
const PROPERTY_TEST_MARKERS = ["fc.assert", "assertProperty"];

/** Every test file the runner executes, in its stable order. */
export const listApiTestPaths = (apiRoot: string): string[] =>
  [
    ...new Bun.Glob(TEST_FILE_GLOB).scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    }),
  ].toSorted();

/** Whether a test file asserts a property, for `run-tests.ts --property`. */
export const hasPropertyTest = (source: string) =>
  PROPERTY_TEST_MARKERS.some((marker) => source.includes(marker));
