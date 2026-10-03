import { panic } from "better-result";
import { readFileSync } from "node:fs";

// The queue's core checks remain separate from the per-commit heavy suites.
export const THIN_JOBS = [
  "ci-checks-generated",
  "ci-checks-policy",
  "ci-checks-rest",
  "code-quality-api",
  "code-quality-web",
  "code-quality-rest",
  "typecheck-baseline",
  "ci-tests",
  "parser-version-guard",
  "web-build",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown) => {
  if (!isRecord(value)) {
    panic("Expected a workflow object");
  }
  return value;
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
  for (const job of THIN_JOBS) {
    if (!gated.includes(job)) {
      panic(`Missing thin job: ${job}`);
    }
  }
  return gated.filter((job) => !THIN_JOBS.some((thin) => thin === job));
};

if (import.meta.main) {
  const source = process.argv.at(2);
  if (!source) {
    panic("Expected workflow path");
  }
  console.log(`thin_jobs=${JSON.stringify(THIN_JOBS)}`);
  console.log(
    `heavy_jobs=${JSON.stringify(mainHeavyJobs(Bun.YAML.parse(readFileSync(source, "utf-8"))))}`,
  );
}
