// Read before dependency installation (workflow guards and the pool runner);
// keep this module free of package imports.
import { readFileSync } from "node:fs";
import path from "node:path";

class CheckPoolRegistryError extends Error {
  override name = "CheckPoolRegistryError";
  readonly _tag = "CheckPoolRegistryError";
}

/** Jobs whose checks live in .github/ci-checks/<job>.yml. */
export const CHECK_POOL_JOBS = [
  "ci-checks-policy",
  "ci-checks-rest",
  "code-quality-web-rest",
] as const;
export type CheckPoolJob = (typeof CHECK_POOL_JOBS)[number];

/** Step names stay unique across jobs: guards key checks by name. */
export const CHECK_POOL_STEP_NAMES = {
  "ci-checks-policy": "Run policy checks",
  "ci-checks-rest": "Run repository checks",
  "code-quality-web-rest": "Run independent code-quality checks",
} as const satisfies Record<CheckPoolJob, string>;
// The pool step writes the job's `needs` to a file and runs the pool on it:
// ci-plan's outputs can exceed the 128 KiB limit of one environment value.
// `exec` makes the pool the step's process: the runner signals only that
// process when it cancels a step, so a shell in between would take the signal
// and the pool could never report what was still running.
const POOL_COMMAND = new RegExp(
  [
    String.raw`^needs_file=\$\(mktemp\)`,
    String.raw`cat > "\$needs_file" <<'CI_CHECK_POOL_NEEDS_JSON'`,
    String.raw`\$\{\{ toJSON\(needs\) \}\}`,
    "CI_CHECK_POOL_NEEDS_JSON",
    String.raw`CI_CHECK_POOL_NEEDS_FILE="\$needs_file" exec bun scripts/ci-check-pool\.ts run ([\w-]+)$`,
  ].join("\n"),
  "u",
);

/** The pool step's script for `job`, exactly as the workflow declares it. */
export const checkPoolStepRun = (job: CheckPoolJob) =>
  [
    "needs_file=$(mktemp)",
    `cat > "$needs_file" <<'CI_CHECK_POOL_NEEDS_JSON'`,
    // Built, not written literally: a `${...}` in a plain string reads as a
    // broken template literal to the linter.
    ["$", "{{ toJSON(needs) }}"].join(""),
    "CI_CHECK_POOL_NEEDS_JSON",
    `CI_CHECK_POOL_NEEDS_FILE="$needs_file" exec bun scripts/ci-check-pool.ts run ${job}`,
    "",
  ].join("\n");

/** One check: the fields of the workflow step it replaced, verbatim. */
export type PoolCheck = {
  name: string;
  id: string | undefined;
  condition: string;
  run: string;
  env: Readonly<Record<string, string>>;
  /** The check's time budget: the pool kills and names a check past it. */
  timeoutMinutes: number;
  /** `continue-on-error` as declared: a literal or a `${{ }}` expression. */
  continueOnError: boolean | string | undefined;
  step: Readonly<Record<string, unknown>>;
};

const CHECK_KEYS = new Set([
  "name",
  "id",
  "if",
  "env",
  "run",
  "timeout-minutes",
  "continue-on-error",
]);

const isCheckPoolJob = (job: string): job is CheckPoolJob =>
  CHECK_POOL_JOBS.some((known) => known === job);

export const checkPoolRegistryPath = (job: CheckPoolJob) =>
  `.github/ci-checks/${job}.yml`;

/** The pooled job a workflow step runs, or undefined for any other step. */
export const checkPoolJob = (
  step: Readonly<Record<string, unknown>>,
): CheckPoolJob | undefined => {
  const run = step["run"];
  const job =
    typeof run === "string" ? POOL_COMMAND.exec(run.trim())?.[1] : undefined;
  if (job === undefined) {
    return undefined;
  }
  if (!isCheckPoolJob(job)) {
    throw new CheckPoolRegistryError(`Unknown check pool job: ${job}`);
  }
  return job;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate a registry file; any shape the pool cannot run faithfully fails. */
export const parseCheckPool = (source: string): PoolCheck[] => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (
    !record(parsed) ||
    Object.keys(parsed).join(",") !== "checks" ||
    !Array.isArray(parsed["checks"]) ||
    parsed["checks"].length === 0
  ) {
    throw new CheckPoolRegistryError("A check pool declares only `checks`");
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  return parsed["checks"].map((entry: unknown) => {
    if (!record(entry)) {
      throw new CheckPoolRegistryError("A pooled check must be a mapping");
    }
    const { name, id, env = {}, run } = entry;
    const condition = entry["if"];
    const timeout = entry["timeout-minutes"];
    const continueOnError = entry["continue-on-error"];
    if (typeof name !== "string" || name.trim() === "" || names.has(name)) {
      throw new CheckPoolRegistryError(
        `Pooled check names must be unique: ${String(name)}`,
      );
    }
    names.add(name);
    const unknown = Object.keys(entry).filter((key) => !CHECK_KEYS.has(key));
    if (unknown.length > 0) {
      throw new CheckPoolRegistryError(
        `${name}: unsupported fields ${unknown.join(", ")}`,
      );
    }
    if (typeof condition !== "string" || typeof run !== "string") {
      throw new CheckPoolRegistryError(`${name}: needs a condition and run`);
    }
    if (id !== undefined && (typeof id !== "string" || ids.has(id))) {
      throw new CheckPoolRegistryError(`${name}: ids must be unique strings`);
    }
    if (typeof id === "string") {
      ids.add(id);
    }
    if (
      !record(env) ||
      !Object.values(env).every((value) => typeof value === "string")
    ) {
      throw new CheckPoolRegistryError(`${name}: env values must be strings`);
    }
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1
    ) {
      throw new CheckPoolRegistryError(
        `${name}: declare timeout-minutes, a whole number of minutes (at least 1) that bounds the check; size it at about 2.5x its worst duration in the pool's summary table`,
      );
    }
    if (
      continueOnError !== undefined &&
      typeof continueOnError !== "boolean" &&
      (typeof continueOnError !== "string" || continueOnError.trim() === "")
    ) {
      throw new CheckPoolRegistryError(`${name}: invalid continue-on-error`);
    }
    return {
      name,
      id: typeof id === "string" ? id : undefined,
      condition,
      run,
      env: Object.fromEntries(
        Object.entries(env).map(([key, value]) => [key, String(value)]),
      ),
      timeoutMinutes: timeout,
      continueOnError,
      step: entry,
    };
  });
};

export type ReadCheckPool = (job: CheckPoolJob) => string;
const ROOT = path.resolve(import.meta.dir, "..");
export const readWorkingTreeCheckPool: ReadCheckPool = (job) =>
  readFileSync(path.join(ROOT, checkPoolRegistryPath(job)), "utf-8");

export const readCheckPool = (
  job: CheckPoolJob,
  read: ReadCheckPool = readWorkingTreeCheckPool,
) => parseCheckPool(read(job));

/** Where the pool leaves per-check outcomes for the receipt recorder. */
export const checkPoolResultsPath = (job: CheckPoolJob, runnerTemp: string) =>
  path.join(runnerTemp, `ci-check-pool-${job}`, "results.json");

/**
 * The CI workflow text followed by every check pool registry: the commands
 * the CI checks workflow runs, for guards that look for a command's text.
 */
export const readCiCheckCommandText = (root: string = ROOT) =>
  [".github/workflows/ci.yml", ...CHECK_POOL_JOBS.map(checkPoolRegistryPath)]
    .map((file) => readFileSync(path.join(root, file), "utf-8"))
    .join("\n");
