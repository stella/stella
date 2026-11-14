export type WorkflowJob = {
  name: string;
  conclusion: string | null;
  steps?: readonly { conclusion: string | null; status?: string }[];
};

// A lost runner fails the job without failing a step: the running step ends cancelled, or no step ran at all.
// A failed job with neither a failed nor a cancelled step is not evidence of a lost runner.
export const runnerLost = (job: WorkflowJob) => {
  const steps = job.steps ?? [];
  return (
    job.conclusion === "failure" &&
    !steps.some((step) => step.conclusion === "failure") &&
    // Every step has finished: a step still running is no evidence yet.
    steps.every(
      (step) => step.status === undefined || step.status === "completed",
    ) &&
    (steps.length === 0 ||
      steps.some((step) => step.conclusion === "cancelled"))
  );
};

export const retryDecision = (
  jobs: readonly WorkflowJob[],
  attempt: number,
): { retry: boolean; reason: string } => {
  if (attempt !== 1) {
    return { retry: false, reason: "only the first attempt can be retried" };
  }
  // ci-result fails because others did: it is never the lost job itself.
  const lost = jobs.filter(
    (job) => job.name !== "ci-result" && runnerLost(job),
  );
  if (lost.length === 0) {
    return { retry: false, reason: "no runner loss was detected" };
  }
  const realFailure = jobs.find(
    (job) =>
      job.conclusion === "failure" &&
      job.name !== "ci-result" &&
      !runnerLost(job),
  );
  if (realFailure) {
    return {
      retry: false,
      reason: (realFailure.steps ?? []).some(
        (step) => step.conclusion === "failure",
      )
        ? `${realFailure.name} contains a failed step`
        : `${realFailure.name} failed without evidence of a lost runner`,
    };
  }
  return {
    retry: true,
    reason: `runner lost for ${lost.map((job) => job.name).join(", ")}`,
  };
};
