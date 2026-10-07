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

/** Scheduling barriers have no check command; callers audit them separately. */
export const isWorkflowBarrier = (step: Record<string, unknown>): boolean =>
  "wait" in step || "wait-all" in step || "cancel" in step;

/** Resolve the background ids a wait barrier completes. */
export const workflowWaitTargets = (
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
