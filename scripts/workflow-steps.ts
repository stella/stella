// Pre-install guards cannot import better-result; keep their errors tagged locally.
class WorkflowStepsInvariantError extends Error {
  override name = "WorkflowStepsInvariantError";
  readonly _tag = "WorkflowStepsInvariantError";
}

/** Enumerate leaf steps without letting a parallel group hide checks from guards. */
export const flattenWorkflowSteps = (
  steps: unknown,
): Record<string, unknown>[] => {
  if (!Array.isArray(steps)) {
    throw new WorkflowStepsInvariantError("Workflow steps must be an array");
  }
  const leaves: Record<string, unknown>[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      throw new WorkflowStepsInvariantError("Workflow step must be an object");
    }
    if ("parallel" in step) {
      if (Object.keys(step).some((key) => key !== "parallel")) {
        throw new WorkflowStepsInvariantError(
          "Parallel groups cannot declare leaf step fields",
        );
      }
      leaves.push(...flattenWorkflowSteps(step.parallel));
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
  return flattenWorkflowSteps(job.steps);
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
