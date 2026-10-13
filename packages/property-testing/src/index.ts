import fc from "fast-check";
import { fileURLToPath } from "node:url";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { failureFingerprint } from "./failure-fingerprint";
import {
  PROPERTY_SEEDS_FILE,
  REPLAY_PATH_PATTERN,
  REPO_ROOT,
  readPinnedSeeds,
} from "./pinned-seeds";
import type { PinnedSeed } from "./pinned-seeds";
import { PropertyTestConfigError } from "./property-test-config-error";
import { readNumRunsFactor } from "./run-factor";

export { PropertyTestConfigError } from "./property-test-config-error";

export { failureFingerprint } from "./failure-fingerprint";
export type { PropertyFailureRecord } from "./failure-fingerprint";

/**
 * Shared fast-check configuration for the repo's property tests.
 *
 * Three CI concerns are centralized here so individual tests do not have to
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
 *     `fc.assert(prop, propertyConfig({ seed, path }))`.
 *
 *  3. Deterministic PR inputs. Unless the caller supplies a seed, the tier
 *     policy supplies the fixed seed for PRs and explores during nightly runs.
 */

const NUM_RUNS_FACTOR_ENV = "PROPERTY_TEST_NUM_RUNS_FACTOR";
export const PROPERTY_TEST_TIMEOUT_BASE_MS_ENV =
  "PROPERTY_TEST_TIMEOUT_BASE_MS";

/** fast-check's own default when a property does not specify `numRuns`. */
const FAST_CHECK_DEFAULT_NUM_RUNS = 100;
const DEFAULT_PROPERTY_TEST_TIMEOUT_MS = 5000;

// fast-check types its time-limit plugin as `Plugin<unknown>`, and its run
// details are invariant in the value type, so it is not assignable to
// `Plugin<Ts>`. The plugin never reads generated values: it times each run
// and clears its timer when the runs complete.
const timeLimitPlugin = <Ts>(timeLimit: number): fc.Plugin<Ts> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the plugin never reads generated values
  fc.interruptAfterTimeLimit(timeLimit) as fc.Plugin<Ts>;

// Treat the common CI values as enabled, but honor an explicit opt-out
// (`CI=false`/`0`) so verbose reporting can be silenced locally.
const isCi = (): boolean => {
  const raw = process.env["CI"];
  return raw !== undefined && raw !== "" && raw !== "false" && raw !== "0";
};

/**
 * Build the `fc.assert` parameters for a property test: pass the per-test
 * tuning you want in PR CI (typically just `numRuns`) and this scales it for
 * the nightly sweep and enables verbose reporting under CI. An omitted seed
 * defaults to propertySeed(): fixed in PR CI, exploratory in the nightly sweep.
 * An explicit seed is preserved.
 *
 * ```ts
 * fc.assert(fc.property(arb, predicate), propertyConfig({ numRuns: 200 }));
 * ```
 */
export const propertyConfig = <Ts>(
  options: Omit<fc.Parameters<Ts>, "seed"> & {
    seed?: number | undefined;
  } = {},
): fc.Parameters<Ts> => {
  const { seed: requestedSeed, ...params } = options;
  const seed = "seed" in options ? requestedSeed : propertySeed();
  const factor = readNumRunsFactor(process.env[NUM_RUNS_FACTOR_ENV]);
  const baseNumRuns = params.numRuns ?? FAST_CHECK_DEFAULT_NUM_RUNS;
  const envPath = process.env["PROPERTY_TEST_PATH"];
  const envSeed = process.env[PROPERTY_TEST_SEED_ENV];
  const envReplayPath =
    envSeed !== undefined &&
    envSeed !== "" &&
    seed === Number(envSeed) &&
    envPath !== undefined &&
    envPath !== ""
      ? envPath
      : undefined;
  if (envReplayPath !== undefined && !REPLAY_PATH_PATTERN.test(envReplayPath)) {
    throw new PropertyTestConfigError(
      "PROPERTY_TEST_PATH must be colon-separated non-negative integers",
    );
  }
  const replayPath = envReplayPath ?? params.path;
  const rawLimit = process.env["PROPERTY_TEST_TIME_LIMIT_MS"];
  const timeLimit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    timeLimit !== undefined &&
    (!Number.isSafeInteger(timeLimit) || timeLimit <= 0)
  ) {
    throw new PropertyTestConfigError(
      "PROPERTY_TEST_TIME_LIMIT_MS must be a positive integer",
    );
  }
  return {
    verbose: isCi(),
    ...params,
    // `propertySeed()` yields undefined under the nightly sweep; fast-check
    // treats an explicit undefined seed as an unset one, but the exact
    // optional-property check does not, so the key is omitted instead.
    ...(seed === undefined ? {} : { seed }),
    ...(replayPath === undefined ? {} : { path: replayPath }),
    ...(factor > 1 && timeLimit !== undefined
      ? {
          plugins: [...(params.plugins ?? []), timeLimitPlugin<Ts>(timeLimit)],
        }
      : {}),
    numRuns: Math.ceil(baseNumRuns * factor),
  };
};

export const PROPERTY_TEST_SEED_ENV = "PROPERTY_TEST_SEED";

/**
 * The repo's fixed seed. Arbitrary: it only has to be stable.
 */
const DEFAULT_PROPERTY_SEED = 20_260_901;

/**
 * The seed a property should run with: fixed in PR CI, absent (so
 * fast-check draws a fresh one) during the nightly sweep.
 *
 * ```ts
 * fc.assert(prop, propertyConfig({ numRuns: 300 }));
 * ```
 *
 * The two runs answer different questions. PR CI is a regression gate: it
 * must fail the same way for everyone, and a counterexample nobody can
 * reproduce from the log is a flake, not a finding. The nightly sweep is
 * the search: it already runs each property ten times longer, and reusing
 * one seed every night would re-walk the same inputs forever, so it draws
 * a new one and explores.
 *
 * Nightly is detected from `PROPERTY_TEST_NUM_RUNS_FACTOR`, the variable
 * the nightly sweep already exports to widen the run budget — one signal
 * for "this is the sweep", rather than a second flag that could be set
 * inconsistently with the first.
 *
 * Set `PROPERTY_TEST_SEED` to pin a specific seed in any environment.
 * That is how a nightly failure is replayed: the run log prints the seed
 * fast-check drew, and exporting it here reproduces the run without
 * editing the test.
 */
export const propertySeed = (): number | undefined => {
  const pinned = process.env[PROPERTY_TEST_SEED_ENV];
  if (pinned !== undefined && pinned !== "") {
    const parsed = Number(pinned);
    if (!Number.isSafeInteger(parsed)) {
      throw new PropertyTestConfigError(
        `${PROPERTY_TEST_SEED_ENV} must be an integer seed, got ${pinned}`,
      );
    }
    return parsed;
  }

  const exploring = readNumRunsFactor(process.env[NUM_RUNS_FACTOR_ENV]) > 1;
  return exploring ? undefined : DEFAULT_PROPERTY_SEED;
};

type PropertySample<T> = {
  value: T;
  /** Replay coordinates and the drawn value, for an `expect` message. */
  label: string;
};

/** fast-check seeds are 32-bit integers. */
const MAX_GENERATED_SEED = 0x80_00_00_00;

type DrawPropertySamplesOptions = {
  numRuns: number;
  seed?: number | undefined;
};

/**
 * Draw the inputs `fc.assert` would run under `propertyConfig`, for tests
 * that evaluate samples as one batch instead of one predicate call each.
 * The seed is always explicit (a random one when the tier policy leaves it
 * unset), so every label replays its batch:
 * `PROPERTY_TEST_SEED=<seed>` redraws the same samples in the same order.
 */
export const drawPropertySamples = <T>(
  arbitrary: fc.Arbitrary<T>,
  { numRuns, seed: requestedSeed }: DrawPropertySamplesOptions,
): PropertySample<T>[] => {
  const seed =
    requestedSeed ??
    propertySeed() ??
    Math.floor(Math.random() * MAX_GENERATED_SEED);
  // PROPERTY_TEST_PATH walks one counterexample's shrink tree; fc.sample would
  // follow it and renumber the batch, so batches replay by seed and index.
  const { path: _path, ...params } = propertyConfig<T>({ numRuns, seed });
  const factor = readNumRunsFactor(process.env[NUM_RUNS_FACTOR_ENV]);
  const factorEnv = factor === 1 ? "" : ` ${NUM_RUNS_FACTOR_ENV}=${factor}`;
  return fc.sample(arbitrary, params).map((value, index) => ({
    value,
    label: `${PROPERTY_TEST_SEED_ENV}=${seed}${factorEnv} sample ${index}: ${fc.stringify(value)}`,
  }));
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

/** Resolve the owning test runner's baseline before applying nightly scaling. */
export const propertyTestDefaultTimeout = (): number => {
  const rawBaseMs = process.env[PROPERTY_TEST_TIMEOUT_BASE_MS_ENV];
  const baseMs =
    rawBaseMs === undefined
      ? DEFAULT_PROPERTY_TEST_TIMEOUT_MS
      : Number(rawBaseMs);
  if (!Number.isSafeInteger(baseMs) || baseMs <= 0) {
    throw new PropertyTestConfigError(
      `${PROPERTY_TEST_TIMEOUT_BASE_MS_ENV} must be a positive integer`,
    );
  }
  return propertyTestTimeout(baseMs);
};

const SELF = import.meta.filename;
// One stack frame, "at fn (/abs/x.test.ts:1:2)" or "at /abs/x.test.ts:1:2".
// Anchored at both ends so matching stays linear in the line length.
const FRAME =
  /^\s*at (?:[^()]* \()?((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^()]*):\d+:\d+\)?\s*$/u;

const callerFile = (): string => {
  const stack = new PropertyTestConfigError("property call site").stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const raw = FRAME.exec(line)?.[1];
    if (raw === undefined) {
      continue;
    }
    const absolute = raw.startsWith("file://") ? fileURLToPath(raw) : raw;
    if (absolute === SELF || !/\.test\.tsx?$/u.test(absolute)) {
      continue;
    }
    if (!isPathInside(REPO_ROOT, absolute)) {
      break;
    }
    return repoRelativePath(REPO_ROOT, absolute);
  }
  throw new PropertyTestConfigError(
    "assertProperty must be called from a repository test file",
  );
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;
const regexEscape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export class PropertyAssertionError extends Error {
  readonly _tag = "PropertyAssertionError";

  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "PropertyAssertionError";
  }
}

const isSyncProperty = <Ts>(
  property: fc.IRawProperty<Ts>,
): property is fc.IProperty<Ts> => !property.isAsync();

type PropertyRunOptions<Ts> = {
  file: string;
  id: string;
  property: fc.IRawProperty<Ts>;
  params: fc.Parameters<Ts>;
  pinned: readonly PinnedSeed[];
};

/** Internal seam: identity and pins are supplied by the public boundary. */
export function runProperty<Ts>(
  options: PropertyRunOptions<Ts> & { property: fc.IAsyncProperty<Ts> },
): Promise<void>;
export function runProperty<Ts>(
  options: PropertyRunOptions<Ts> & { property: fc.IProperty<Ts> },
): void;
export function runProperty<Ts>(
  options: PropertyRunOptions<Ts>,
): void | Promise<void>;
export function runProperty<Ts>({
  file,
  id,
  property,
  params,
  pinned,
}: PropertyRunOptions<Ts>): void | Promise<void> {
  if ("reporter" in params || "asyncReporter" in params) {
    throw new PropertyTestConfigError(
      "assertProperty owns failure reporting; custom reporters are unsupported",
    );
  }
  const report = (details: fc.RunDetails<Ts>): void => {
    if (!details.failed) {
      return;
    }
    const factor = readNumRunsFactor(
      process.env["PROPERTY_TEST_NUM_RUNS_FACTOR"],
    );
    const factorEnv =
      factor === 1 ? "" : ` PROPERTY_TEST_NUM_RUNS_FACTOR=${factor}`;
    const workspace = file.split("/").slice(0, 2).join("/");
    const testFile = `./${repoRelativePath(workspace, file)}`;
    const replay = `PROPERTY_TEST_SEED=${details.seed} PROPERTY_TEST_PATH=${shellQuote(details.counterexamplePath ?? "")}${factorEnv} bun run --cwd ${shellQuote(workspace)} test --preload @stll/property-testing/preload ${shellQuote(testFile)} -t ${shellQuote(regexEscape(id))}`;
    const error =
      details.errorInstance instanceof Error
        ? details.errorInstance.message
        : fc.stringify(details.errorInstance);
    const ci = process.env["CI"];
    if (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") {
      console.error(
        `STELLA_PROPERTY_FAILURE ${JSON.stringify({
          file,
          id,
          seed: details.seed,
          path: details.counterexamplePath,
          factor,
          fingerprint: failureFingerprint({ id, error }),
          replay,
          ...(process.env["PROPERTY_TEST_REDACT"] === undefined
            ? { counterexample: fc.stringify(details.counterexample) }
            : {}),
        })}`,
      );
    }
    const hint = {
      [`${file}::${id}`]: [
        {
          seed: details.seed,
          ...(details.counterexamplePath === null ||
          details.counterexamplePath === ""
            ? {}
            : { path: details.counterexamplePath }),
          note: "Regression coverage",
          date: "YYYY-MM-DD",
        },
      ],
    };
    const message = fc.defaultReportMessage(details) ?? "Property failed";
    throw new PropertyAssertionError(
      `${message}\n\nReplay: ${replay}\nPin: ${JSON.stringify(hint)} in ${PROPERTY_SEEDS_FILE}`,
      { cause: details.errorInstance },
    );
  };
  // fast-check runs completion hooks inside the check and rethrows the first
  // error, so the report replaces fast-check's own failure.
  const reportPlugin: fc.Plugin<Ts> = () => ({ onAllRunsComplete: report });
  const plugins = [...(params.plugins ?? []), reportPlugin];
  const generated = propertyConfig({ ...params, plugins });
  // Pinned runs preserve their recorded path and cannot be truncated by a nightly time box.
  const replays = pinned.map(({ seed, path: replayPath }) => {
    const { path: _path, plugins: _plugins, ...base } = generated;
    return {
      ...base,
      plugins,
      seed,
      ...(replayPath === undefined ? {} : { path: replayPath }),
      examples: [],
    };
  });
  if (isSyncProperty(property)) {
    for (const replay of replays) {
      fc.assert(property, replay);
    }
    fc.assert(property, generated);
    return;
  }
  return (async () => {
    for (const replay of replays) {
      await fc.assert(property, replay);
    }
    await fc.assert(property, generated);
  })();
}

export function assertProperty<Ts>(
  id: string,
  property: fc.IAsyncProperty<Ts>,
  params?: fc.Parameters<Ts>,
): Promise<void>;
export function assertProperty<Ts>(
  id: string,
  property: fc.IProperty<Ts>,
  params?: fc.Parameters<Ts>,
): void;
export function assertProperty<Ts>(
  id: string,
  property: fc.IRawProperty<Ts>,
  params: fc.Parameters<Ts> = {},
): void | Promise<void> {
  if (id.trim() === "") {
    throw new PropertyTestConfigError(
      "assertProperty requires a non-empty explicit id",
    );
  }
  const file = callerFile();
  return runProperty({
    file,
    id,
    property,
    params,
    pinned:
      readPinnedSeeds().unwrap("Pinned property seed registry must be valid")[
        `${file}::${id}`
      ] ?? [],
  });
}
