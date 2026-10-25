import { panic } from "better-result";
import { readFileSync } from "node:fs";

import { prDepthJobs } from "./ci-pr-jobs";
import { HEAVY_PROOF_GATE } from "./heavy-proof-gate";

export { prDepthJobs } from "./ci-pr-jobs";

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
  const foldedJson = record(scopes)["FOLDED_SUITES"];
  if (typeof foldedJson !== "string") {
    panic("Expected FOLDED_SUITES JSON");
  }
  // Folded verdicts remain mandatory at full depth, including main-heavy.
  for (const job of Object.keys(record(JSON.parse(foldedJson)))) {
    if (!gated.includes(job) || thin.includes(job)) {
      panic(`Folded suites require a main-heavy producer: ${job}`);
    }
  }
  for (const job of thin) {
    if (!gated.includes(job)) {
      panic(`Missing thin job: ${job}`);
    }
  }
  return gated.filter((job) => !thin.includes(job));
};

// These jobs cannot certify the queued tree: they either consume a different
// revision or duplicate a producer selected for an ordinary merge group.
export const MERGE_GROUP_EXCEPTIONS = {
  "fix-tests-on-base":
    "Negative proof against the pull request base, rather than the queued tree.",
  "heavy-web-build":
    "Heavy-dispatch artifact producer; web-build produces the merge-group artifact.",
  "pr-heavy-gate":
    "Pull request ordering gate; a merge group starts its suites after the plan.",
} as const;

export {
  ARMED_LABEL,
  HEAVY_PROOF_GATE,
  MERGE_GROUP_HEAVY_KEEP,
} from "./heavy-proof-gate";

const jobCondition = (job: unknown) => {
  const condition = record(job)["if"];
  return typeof condition === "string" ? condition : "";
};

// The gate as a conjunct. A job that only offers it as one alternative
// (web-build, which also builds for selected browser specs) is not gated.
const GATED = new RegExp(
  `(?<!\\|\\|\\s*)${HEAVY_PROOF_GATE.replaceAll(".", "\\.")}`,
  "u",
);

/** Every job gated on the armed heavy proof, in workflow order. */
export const heavyProofJobs = (workflow: unknown) =>
  Object.entries(record(record(workflow)["jobs"])).flatMap(([name, job]) =>
    GATED.test(jobCondition(job)) ? [name] : [],
  );

export const heavyProofJobScopes = (workflow: unknown) => {
  const result = record(record(record(workflow)["jobs"])["ci-result"]);
  const steps = result["steps"];
  if (!Array.isArray(steps)) {
    panic("Expected ci-result steps");
  }
  const outcome = steps.find(
    (step) => record(step)["name"] === "Evaluate CI outcome",
  );
  const source = record(record(outcome)["env"])["JOB_SCOPES"];
  if (typeof source !== "string") {
    panic("Expected JOB_SCOPES JSON");
  }
  const scopes = record(JSON.parse(source));
  const foldedSource = record(record(outcome)["env"])["FOLDED_SUITES"];
  if (typeof foldedSource !== "string") {
    panic("Expected FOLDED_SUITES JSON");
  }
  const folded = record(JSON.parse(foldedSource));
  const required = new Set([...thinJobs(workflow), ...mainHeavyJobs(workflow)]);
  return Object.fromEntries(
    heavyProofJobs(workflow)
      .filter((name) => required.has(name))
      .map((name) => {
        if (Object.hasOwn(folded, name)) {
          panic(`Folded suites require queued coverage: ${name}`);
        }
        const scope = scopes[name];
        if (scope !== null && typeof scope !== "string") {
          panic(`Missing heavy job scope: ${name}`);
        }
        return [name, scope];
      }),
  );
};

export const queueAdmittedJobs = (workflow: unknown) => {
  const gated = [...thinJobs(workflow), ...mainHeavyJobs(workflow)];
  for (const exception of Object.keys(MERGE_GROUP_EXCEPTIONS)) {
    if (!gated.includes(exception)) {
      panic(`Stale merge-group exception: ${exception}`);
    }
  }
  return gated.filter((job) => !Object.hasOwn(MERGE_GROUP_EXCEPTIONS, job));
};

if (import.meta.main) {
  const source = process.argv.at(2);
  if (!source) {
    panic("Expected workflow path");
  }
  const workflow: unknown = Bun.YAML.parse(readFileSync(source, "utf-8"));
  console.log(`thin_jobs=${JSON.stringify(thinJobs(workflow))}`);
  console.log(`heavy_jobs=${JSON.stringify(mainHeavyJobs(workflow))}`);
  console.log(
    `armed_job_scopes=${JSON.stringify(heavyProofJobScopes(workflow))}`,
  );
  console.log(`queue_jobs=${JSON.stringify(queueAdmittedJobs(workflow))}`);
  console.log(`pr_depth_jobs=${JSON.stringify(prDepthJobs(workflow))}`);
}
