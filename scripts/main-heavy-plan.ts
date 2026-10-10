import { panic } from "better-result";
import { readFileSync } from "node:fs";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown) => {
  if (!isRecord(value)) {
    panic("Expected a workflow object");
  }
  return value;
};

export const thinJobs = (workflow: unknown) => {
  const jobs = record(record(workflow)["jobs"]);
  // The workflow owns which jobs a heavy-only dispatch omits. Derive the
  // partition from those predicates, including the regular web build whose
  // artifact is produced by heavy-web-build on a heavy dispatch.
  return Object.entries(jobs).flatMap(([name, job]) => {
    const condition = record(job)["if"];
    return typeof condition === "string" &&
      /\binputs\.heavy_only\s*!=\s*true\b/u.test(condition)
      ? [name]
      : [];
  });
};

export const mainHeavyJobs = (workflow: unknown) => {
  const jobs = record(record(workflow)["jobs"]);
  const result = record(jobs["ci-result"]);
  const needs = result["needs"];
  if (
    !Array.isArray(needs) ||
    !needs.every((job): job is string => typeof job === "string")
  ) {
    panic("Expected ci-result job dependencies");
  }
  const steps = result["steps"];
  if (!Array.isArray(steps)) {
    panic("Expected ci-result steps");
  }
  const outcome = steps.find(
    (step: unknown) => record(step)["name"] === "Evaluate CI outcome",
  );
  const scopes = record(outcome)["env"];
  const scopeJson = record(scopes)["JOB_SCOPES"];
  if (typeof scopeJson !== "string") {
    panic("Expected JOB_SCOPES JSON");
  }
  const jobScopes = record(JSON.parse(scopeJson));
  const gated = needs.filter((job) => job !== "ci-plan");
  if (
    gated.length !== Object.keys(jobScopes).length ||
    gated.some((job) => !Object.hasOwn(jobScopes, job))
  ) {
    panic("ci-result dependencies and JOB_SCOPES disagree");
  }
  const thin = thinJobs(workflow);
  for (const job of thin) {
    if (!gated.includes(job)) {
      panic(`Missing thin job: ${job}`);
    }
  }
  return gated.filter((job) => !thin.includes(job));
};

export const prDepthJobs = (workflow: unknown) => {
  const jobs = record(record(workflow)["jobs"]);
  const result = record(jobs["ci-result"]);
  const steps = result["steps"];
  if (!Array.isArray(steps)) {
    panic("Expected ci-result steps");
  }
  const outcome = steps.find(
    (step: unknown) => record(step)["name"] === "Evaluate CI outcome",
  );
  const env = record(outcome)["env"];
  const required = record(env)["FAST_REQUIRED"];
  if (typeof required !== "string") {
    panic("Expected FAST_REQUIRED JSON");
  }
  const fastRequired: unknown = JSON.parse(required);
  if (
    !Array.isArray(fastRequired) ||
    !fastRequired.every((job) => typeof job === "string")
  ) {
    panic("Expected FAST_REQUIRED job names");
  }
  // ci-checks-docs replaces the package checks on docs-only changes and never
  // runs on main, so it is neither repeated by a merge group nor checkable by
  // the scheduled main run.
  return fastRequired.filter(
    (job) =>
      job !== "ci-checks-docs" &&
      (job === "ci-generated-sources" ||
        job.startsWith("ci-checks-") ||
        job.startsWith("code-quality-")),
  );
};

/** Heavy jobs a thin merge group still runs unless the switch turns them off. */
export const QUEUE_BROWSER_SUITES_SWITCH = "vars.QUEUE_BROWSER_SUITES";

export const queueAdmittedJobs = (workflow: unknown) => {
  const jobs = record(record(workflow)["jobs"]);
  return mainHeavyJobs(workflow).filter((name) => {
    const condition = record(jobs[name])["if"];
    return (
      typeof condition === "string" &&
      condition.includes(QUEUE_BROWSER_SUITES_SWITCH)
    );
  });
};

if (import.meta.main) {
  const source = process.argv.at(2);
  if (!source) {
    panic("Expected workflow path");
  }
  const workflow: unknown = Bun.YAML.parse(readFileSync(source, "utf-8"));
  console.log(`thin_jobs=${JSON.stringify(thinJobs(workflow))}`);
  console.log(`heavy_jobs=${JSON.stringify(mainHeavyJobs(workflow))}`);
  console.log(`pr_depth_jobs=${JSON.stringify(prDepthJobs(workflow))}`);
}
