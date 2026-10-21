export class WorkflowPlanError extends Error {
  override name = "WorkflowPlanError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown) => {
  if (!isRecord(value)) {
    throw new WorkflowPlanError("Expected a workflow object");
  }
  return value;
};

export const prDepthJobs = (workflow: unknown) => {
  const jobs = record(record(workflow)["jobs"]);
  const steps = record(jobs["ci-result"])["steps"];
  if (!Array.isArray(steps)) {
    throw new WorkflowPlanError("Expected ci-result steps");
  }
  const outcome = steps.find(
    (step: unknown) => record(step)["name"] === "Evaluate CI outcome",
  );
  const required = record(record(outcome)["env"])["FAST_REQUIRED"];
  if (typeof required !== "string") {
    throw new WorkflowPlanError("Expected FAST_REQUIRED JSON");
  }
  const fastRequired: unknown = JSON.parse(required);
  if (
    !Array.isArray(fastRequired) ||
    !fastRequired.every((job) => typeof job === "string")
  ) {
    throw new WorkflowPlanError("Expected FAST_REQUIRED job names");
  }
  const checks = fastRequired.filter(
    (job) => job.startsWith("ci-checks-") || job.startsWith("code-quality-"),
  );
  const producers = checks.flatMap((job) => {
    const needs: unknown = record(jobs[job])["needs"];
    if (typeof needs === "string") {
      return [needs];
    }
    return Array.isArray(needs) ? needs : [];
  });
  return [...new Set([...checks, ...producers])].filter(
    (job): job is string => typeof job === "string" && job !== "ci-plan",
  );
};

export const prHeavyJobs = (workflow: unknown) => {
  const jobs = record(record(workflow)["jobs"]);
  const heavy = ["pr-heavy-gate"];
  while (true) {
    const added = Object.keys(jobs).filter((name) => {
      if (name === "ci-result" || heavy.includes(name)) {
        return false;
      }
      const needs = record(jobs[name])["needs"];
      const dependencies = typeof needs === "string" ? [needs] : needs;
      return (
        Array.isArray(dependencies) &&
        dependencies.some(
          (dependency) =>
            typeof dependency === "string" && heavy.includes(dependency),
        )
      );
    });
    if (added.length === 0) {
      return heavy.slice(1).toSorted();
    }
    heavy.push(...added);
  }
};
