import { INSTALL_STALL_TITLE } from "./ci-install";

export type WorkflowJob = {
  name: string;
  conclusion: string | null;
  steps?: readonly { conclusion: string | null; status?: string }[];
  // The job's check-run annotations; read only for jobs with one failed step.
  annotations?: readonly { title: string | null }[];
};

// Every step has finished: a step still running is no evidence yet.
const stepsFinished = (steps: NonNullable<WorkflowJob["steps"]>) =>
  steps.every(
    (step) => step.status === undefined || step.status === "completed",
  );

// A lost runner fails the job without failing a step: the running step ends cancelled, or no step ran at all.
// A failed job with neither a failed nor a cancelled step is not evidence of a lost runner.
export const runnerLost = (job: WorkflowJob) => {
  const steps = job.steps ?? [];
  return (
    job.conclusion === "failure" &&
    !steps.some((step) => step.conclusion === "failure") &&
    stepsFinished(steps) &&
    (steps.length === 0 ||
      steps.some((step) => step.conclusion === "cancelled"))
  );
};

// A stalled install ends the job at its step, so the stall annotation explains
// the job only when that step is its single failed step.
export const installStalled = (job: WorkflowJob) => {
  const steps = job.steps ?? [];
  return (
    job.conclusion === "failure" &&
    stepsFinished(steps) &&
    steps.filter((step) => step.conclusion === "failure").length === 1 &&
    (job.annotations ?? []).some(({ title }) => title === INSTALL_STALL_TITLE)
  );
};

export const retryDecision = (
  jobs: readonly WorkflowJob[],
  attempt: number,
): { retry: boolean; reason: string } => {
  if (attempt !== 1) {
    return { retry: false, reason: "only the first attempt can be retried" };
  }
  // ci-result fails because others did: it is never a cause itself.
  const failures = jobs.filter(
    (job) => job.conclusion === "failure" && job.name !== "ci-result",
  );
  const lost = failures.filter(runnerLost);
  const stalled = failures.filter(installStalled);
  if (lost.length === 0 && stalled.length === 0) {
    return {
      retry: false,
      reason: "no runner loss or install stall was detected",
    };
  }
  const realFailure = failures.find(
    (job) => !runnerLost(job) && !installStalled(job),
  );
  if (realFailure) {
    return {
      retry: false,
      reason: (realFailure.steps ?? []).some(
        (step) => step.conclusion === "failure",
      )
        ? `${realFailure.name} contains a failed step that is not an install stall`
        : `${realFailure.name} failed without evidence of a lost runner`,
    };
  }
  const causes: string[] = [];
  if (lost.length > 0) {
    causes.push(`runner lost for ${lost.map((job) => job.name).join(", ")}`);
  }
  if (stalled.length > 0) {
    causes.push(
      `install stalled for ${stalled.map((job) => job.name).join(", ")}`,
    );
  }
  return { retry: true, reason: causes.join("; ") };
};
