import {
  type CheckBudgets,
  checkPoolJob,
  readCheckBudgets,
  type ReadCheckPool,
  readCheckPool,
  readWorkingTreeCheckPool,
} from "./ci-check-pool-registry";

// Pre-install guards cannot import better-result; keep their errors tagged locally.
class WorkflowStepsInvariantError extends Error {
  override name = "WorkflowStepsInvariantError";
  readonly _tag = "WorkflowStepsInvariantError";
}

/** Read the exact ordered install inputs from the shared CI owner. */
export const workflowCiInstallFlags = (
  step: Record<string, unknown>,
): string[] => {
  if (
    step["uses"] !== "$/.github/actions/ci-install" &&
    step["uses"] !== "./.github/actions/ci-install"
  ) {
    throw new WorkflowStepsInvariantError(
      "Expected the shared CI install action",
    );
  }
  const inputs = step["with"];
  if (
    typeof inputs !== "object" ||
    inputs === null ||
    !("flags" in inputs) ||
    typeof inputs.flags !== "string"
  ) {
    throw new WorkflowStepsInvariantError("Missing CI install flags");
  }
  const flags: unknown = JSON.parse(inputs.flags);
  if (
    !Array.isArray(flags) ||
    !flags.every((flag): flag is string => typeof flag === "string")
  ) {
    throw new WorkflowStepsInvariantError("CI install flags must be strings");
  }
  return flags;
};

const isStepRecord = (step: unknown): step is Record<string, unknown> =>
  typeof step === "object" && step !== null && !Array.isArray(step);

let budgets: CheckBudgets | undefined;
/**
 * The pool bounds every check by its budget, so an expanded check without a
 * declared `timeout-minutes` carries that bound for guards that require one.
 * Budgets come from the working tree, the file the pool itself enforces.
 */
const withBudget = (
  pool: NonNullable<ReturnType<typeof checkPoolJob>>,
  step: Readonly<Record<string, unknown>>,
) => {
  budgets ??= readCheckBudgets();
  const name = String(step["name"]);
  const budget = Object.hasOwn(budgets[pool], name)
    ? budgets[pool][name]
    : undefined;
  return budget === undefined || step["timeout-minutes"] !== undefined
    ? { ...step }
    : { ...step, "timeout-minutes": budget.minutes };
};

/**
 * Follow each check pool step with the checks it runs, read through
 * `readPool` (the working tree unless a caller audits another tree). Steps
 * that already carry their pool's checks are left as they are.
 */
export const withPooledChecks = (
  steps: readonly unknown[],
  readPool: ReadCheckPool = readWorkingTreeCheckPool,
): unknown[] =>
  steps.flatMap((step, index) => {
    if (!isStepRecord(step)) {
      return [step];
    }
    const pool = checkPoolJob(step);
    if (pool === undefined) {
      return [step];
    }
    const checks = readCheckPool(pool, readPool);
    const expanded = checks.every((check, offset) => {
      const next: unknown = steps[index + 1 + offset];
      return isStepRecord(next) && next["name"] === check.name;
    });
    return expanded
      ? [step]
      : [step, ...checks.map((check) => withBudget(pool, check.step))];
  });

/**
 * Enumerate leaf steps without letting a parallel group or a check pool hide
 * checks from guards (see `withPooledChecks`).
 */
export const flattenWorkflowSteps = (
  steps: unknown,
  readPool: ReadCheckPool = readWorkingTreeCheckPool,
): Record<string, unknown>[] => {
  if (!Array.isArray(steps)) {
    throw new WorkflowStepsInvariantError("Workflow steps must be an array");
  }
  const leaves: Record<string, unknown>[] = [];
  for (const step of withPooledChecks(steps, readPool)) {
    if (!isStepRecord(step)) {
      throw new WorkflowStepsInvariantError("Workflow step must be an object");
    }
    if ("parallel" in step) {
      if (Object.keys(step).some((key) => key !== "parallel")) {
        throw new WorkflowStepsInvariantError(
          "Parallel groups cannot declare leaf step fields",
        );
      }
      leaves.push(...flattenWorkflowSteps(step["parallel"], readPool));
      continue;
    }
    leaves.push(step);
  }
  return leaves;
};

/** Read a job structurally so adjacent YAML cannot become a step command. */
export const workflowJobSteps = (
  workflow: unknown,
  jobId: string,
  readPool: ReadCheckPool = readWorkingTreeCheckPool,
): Record<string, unknown>[] => {
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    !("jobs" in workflow) ||
    typeof workflow.jobs !== "object" ||
    workflow.jobs === null ||
    !(jobId in workflow.jobs)
  ) {
    throw new WorkflowStepsInvariantError(`Missing workflow job: ${jobId}`);
  }
  const job: unknown = Reflect.get(workflow.jobs, jobId);
  if (typeof job !== "object" || job === null || !("steps" in job)) {
    throw new WorkflowStepsInvariantError(`Missing workflow steps: ${jobId}`);
  }
  return flattenWorkflowSteps(job.steps, readPool);
};

/** Named script extraction must fail on absent or ambiguous workflow steps. */
export const workflowStepByName = (
  steps: unknown,
  name: string,
): Record<string, unknown> => {
  const matches = flattenWorkflowSteps(steps).filter(
    (step) => step["name"] === name,
  );
  const step = matches.at(0);
  if (matches.length !== 1 || step === undefined) {
    throw new WorkflowStepsInvariantError(
      `Expected one workflow step named ${name}; found ${matches.length}`,
    );
  }
  return step;
};

/** Scheduling barriers have no check command; callers audit them separately. */
export const isWorkflowBarrier = (step: Record<string, unknown>): boolean =>
  "wait" in step || "wait-all" in step || "cancel" in step;

/** Resolve the background ids a wait barrier completes. */
const workflowWaitTargets = (
  step: Record<string, unknown>,
  pendingIds: Iterable<string>,
): string[] | undefined => {
  if ("wait-all" in step) {
    return [...pendingIds];
  }
  if (!("wait" in step)) {
    return undefined;
  }
  if (typeof step["wait"] === "string") {
    return [step["wait"]];
  }
  return Array.isArray(step["wait"])
    ? step["wait"].filter((id): id is string => typeof id === "string")
    : [];
};

/** Consume synchronization barriers without certifying canceled work. */
export const synchronizeWorkflowBackgroundSteps = <Proof>(
  step: Record<string, unknown>,
  pending: Map<string, Proof[]>,
): Proof[] | undefined => {
  if ("cancel" in step) {
    if (typeof step["cancel"] !== "string") {
      throw new WorkflowStepsInvariantError(
        "Workflow cancel target must be a step id",
      );
    }
    pending.delete(step["cancel"]);
    return [];
  }
  const targets = workflowWaitTargets(step, pending.keys());
  if (targets === undefined) {
    return undefined;
  }
  const completed: Proof[] = [];
  for (const id of targets) {
    // Read-only background steps need no install proof and may be absent here.
    const proofs = pending.get(id);
    if (proofs === undefined) {
      continue;
    }
    completed.push(...proofs);
    pending.delete(id);
  }
  return completed;
};

type WorkflowParallelBranch<Proof> = {
  readonly step: unknown;
  readonly installs: Proof[];
  readonly pending: Map<string, Proof[]>;
  readonly cancelled: ReadonlySet<string>;
};

type MergeWorkflowParallelProofsOptions<Proof> = {
  readonly steps: readonly unknown[];
  readonly installs: readonly Proof[];
  readonly pending: Map<string, Proof[]>;
  readonly cancelled: ReadonlySet<string>;
  readonly walk: (branch: WorkflowParallelBranch<Proof>) => readonly Proof[];
};

/** Join isolated branches; any sibling cancellation invalidates that id's proof. */
export const mergeWorkflowParallelProofs = <Proof>({
  steps,
  installs,
  pending,
  cancelled: inheritedCancelled,
  walk,
}: MergeWorkflowParallelProofsOptions<Proof>): Proof[] => {
  const cancelled = new Set(inheritedCancelled);
  const remaining = [...steps];
  while (remaining.length > 0) {
    const step = remaining.pop();
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      continue;
    }
    if ("cancel" in step && typeof step.cancel === "string") {
      cancelled.add(step.cancel);
    }
    if (
      Object.keys(step).length === 1 &&
      "parallel" in step &&
      Array.isArray(step.parallel)
    ) {
      remaining.push(...step.parallel);
    }
  }
  // Gather first: a wait sibling must never certify work canceled by another branch.
  for (const id of cancelled) {
    pending.delete(id);
  }
  const before = installs.length;
  const pendingBefore = new Map(
    [...pending].map(([id, records]) => [id, records.length]),
  );
  const additions: Proof[] = [];
  for (const step of steps) {
    const branchPending = new Map(
      [...pending].map(([id, records]) => [id, [...records]]),
    );
    const branch = walk({
      step,
      installs: [...installs],
      pending: branchPending,
      cancelled,
    });
    const cancelledStep =
      typeof step === "object" &&
      step !== null &&
      "id" in step &&
      typeof step.id === "string" &&
      cancelled.has(step.id);
    if (!cancelledStep) {
      additions.push(...branch.slice(before));
    }
    for (const [id, records] of branchPending) {
      if (cancelled.has(id)) {
        continue;
      }
      const priorCount = pendingBefore.get(id) ?? 0;
      additions.push(...records.slice(priorCount));
    }
  }
  return additions;
};
