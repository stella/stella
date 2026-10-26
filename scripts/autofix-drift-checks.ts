// CI checks whose failure can be drift the changed-file autofix repairs.
//
// The autofix job (.github/workflows/autofix.yml) formats and safely lints
// pull request files, reruns autofix-owned generators, aligns Tauri
// counterparts and prunes shrink-only baselines. CI already checks each of
// those, so CI decides when autofix runs: every job below reports a `fixable`
// output, and ci.yml's `autofix-dispatch` job requests the autofix workflow
// only when one of them is true. A clean pull request, or one red only on
// other checks (tests, typecheck, policy), never starts it.
//
// How a job derives `fixable` from a listed check:
// - `pool`: a pooled check; `scripts/ci-check-pool.ts` writes the step output
//   `fixable` when a listed check fails.
// - `self-report`: the check's owning script writes `fixable` only when it
//   identifies a failure that changed-file autofix can repair.
// - `outcome`: a workflow step; the job output tests its failed outcome.
// - `code-check`: a `code-check` step, which writes `fixable` itself when a
//   failed task belongs to a changed-file autofix repairable family.
//
// scripts/autofix-drift-checks.test.ts derives the required entries from the
// generator manifest, the baseline writers and the workflow, so a drift guard
// cannot be added without reaching this list.

type DriftSignal = "pool" | "self-report" | "outcome" | "code-check";

type DriftCheck = {
  readonly job: string;
  readonly name: string;
  readonly signal: DriftSignal;
};

export const AUTOFIX_DRIFT_CHECKS = [
  {
    job: "pr-heavy-gate",
    name: "Check workflow job classifications",
    signal: "outcome",
  },
  { job: "ci-checks-policy", name: "Format", signal: "pool" },
  {
    job: "ci-checks-rest",
    name: "Tauri package alignment",
    signal: "outcome",
  },
  {
    job: "ci-checks-rest",
    name: "Generated files manifest guard",
    signal: "self-report",
  },
  { job: "ci-checks-rest", name: "Module ownership", signal: "pool" },
  { job: "ci-checks-rest", name: "Design token docs", signal: "pool" },
  {
    job: "ci-checks-rest",
    name: "Queue authority",
    signal: "pool",
  },
  {
    job: "ci-checks-rest",
    name: "Query data state baseline",
    signal: "pool",
  },
  {
    job: "ci-checks-rest",
    name: "SQL performance baseline",
    signal: "pool",
  },
  {
    job: "ci-checks-rest",
    name: "Failure-as-empty baseline",
    signal: "pool",
  },
  {
    job: "ci-checks-rest",
    name: "Transfer timeout and fixed read guard",
    signal: "pool",
  },
  {
    job: "ci-checks-generated",
    name: "CLI sharded registry and derived runtime guard",
    signal: "outcome",
  },
  {
    job: "ci-checks-generated",
    name: "MCP app derived outputs guard",
    signal: "outcome",
  },
  {
    job: "ci-checks-generated",
    name: "Visual sandbox document tests",
    signal: "outcome",
  },
  {
    job: "ci-checks-generated",
    name: "Capability catalog drift guard",
    signal: "outcome",
  },
  {
    job: "ci-checks-generated",
    name: "Route tree drift guard",
    signal: "outcome",
  },
  { job: "code-quality-api", name: "Code quality", signal: "code-check" },
  {
    job: "code-quality-web-rest",
    name: "Code quality (web)",
    signal: "code-check",
  },
  {
    job: "code-quality-web-rest",
    name: "Typecheck coverage",
    signal: "outcome",
  },
  {
    job: "code-quality-web-rest",
    name: "Code quality (rest)",
    signal: "code-check",
  },
  {
    job: "code-quality-web-rest",
    name: "Aggregate ownership",
    signal: "self-report",
  },
] as const satisfies readonly DriftCheck[];

/** Whether a failed pooled check in `job` can be autofix-repairable drift. */
export const poolDriftFailed = (
  job: string,
  failedChecks: readonly string[],
): boolean =>
  AUTOFIX_DRIFT_CHECKS.some(
    (check) =>
      check.signal === "pool" &&
      check.job === job &&
      failedChecks.includes(check.name),
  );

// Match only task families emitted by scopedCommands and repaired by the
// changed-file autofix. Unknown root checks fail closed.
const REPAIRABLE_CODE_CHECK_TASKS = [
  /^@stll\/[^#]+#lint$/u,
  /^bash scripts\/lint-root-scripts\.sh$/u,
  /^bun --bun oxlint -c oxlint\.config\.ts --report-unused-disable-directives-severity=error --type-aware --type-check .+$/u,
  /^bun run env:check$/u,
] as const;

/** Whether any failed code-check task can be autofix-repairable drift. */
export const fixableCodeCheckTasks = (tasks: readonly string[]): boolean =>
  tasks.some((task) =>
    REPAIRABLE_CODE_CHECK_TASKS.some((pattern) => pattern.test(task)),
  );
