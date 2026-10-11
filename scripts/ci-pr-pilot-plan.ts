import { readFileSync } from "node:fs";

export const PILOT_FAST_ROOTS = [
  "desktop-rust-lint",
  "ci-checks-docs",
  "ci-checks-generated",
  "ci-checks-policy",
  "ci-checks-rest",
  "ci-tests",
  "code-quality-api",
  "code-quality-web-rest",
] as const;
// Queue-only Docker checks remain deferred on PRs, including the pilot profile.
export const PILOT_DEFERRED = [
  "docker-checks",
  "parser-version-guard",
  "ci-generated-sources",
  "ci-browser",
  "service-suites",
  "migration-upgrade-rehearsal",
  "release-typecheck",
  "fix-tests-on-base",
  "web-build",
  "web-image-smoke",
  "mobile-build",
  "landing-build",
  "heavy-web-build",
  "route-smoke",
  "e2e-production-shard",
  "stack-redaction-browsers",
  "e2e-vite-canary",
  "e2e-landing",
  "marketing-screenshots",
  "marketing-screenshots-cancel",
  "e2e-report",
  "api-image-smoke",
  "legal-atlas-image",
  "windows-scripts",
  "desktop-rust-tests",
  "dependency-malware",
  "api-test-durations",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string) => ({ status: "invalid", message }) as const;

// Install-free: ci-plan must classify its graph without loading package dependencies.
export const pilotFastJobs = (workflow: unknown) => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return invalid("Expected workflow jobs");
  }
  const jobs = workflow["jobs"];
  const declared = new Set<string>([
    "ci-plan",
    "ci-result",
    ...PILOT_FAST_ROOTS,
    ...PILOT_DEFERRED,
  ]);
  for (const job of Object.keys(jobs)) {
    if (!declared.has(job)) {
      return invalid(`Unclassified pilot job: ${job}`);
    }
  }
  for (const job of declared) {
    if (!Object.hasOwn(jobs, job)) {
      return invalid(`Stale pilot job: ${job}`);
    }
  }
  const selected = new Set<string>(["ci-plan", "ci-result"]);
  const pending: string[] = [...PILOT_FAST_ROOTS];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || selected.has(name)) {
      continue;
    }
    if (
      name !== "ci-generated-sources" &&
      !PILOT_FAST_ROOTS.some((root) => root === name)
    ) {
      return invalid(`Pilot prerequisite is deferred: ${name}`);
    }
    const job = jobs[name];
    if (!isRecord(job)) {
      return invalid(`Invalid pilot job: ${name}`);
    }
    selected.add(name);
    const needs = job["needs"];
    const prerequisites = typeof needs === "string" ? [needs] : (needs ?? []);
    if (
      !Array.isArray(prerequisites) ||
      !prerequisites.every((item) => typeof item === "string")
    ) {
      return invalid(`Invalid pilot dependencies: ${name}`);
    }
    for (const prerequisite of prerequisites) {
      if (!selected.has(prerequisite)) {
        pending.push(prerequisite);
      }
    }
  }
  return { status: "valid", jobs: [...selected].toSorted() } as const;
};

export const pilotQueueJobs = (workflow: unknown) => {
  const fast = pilotFastJobs(workflow);
  if (fast.status === "invalid") {
    return fast;
  }
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return invalid("Expected workflow jobs");
  }
  const result = workflow["jobs"]["ci-result"];
  if (!isRecord(result) || !Array.isArray(result["steps"])) {
    return invalid("Expected CI result steps");
  }
  const outcome = result["steps"].find(
    (step: unknown) => isRecord(step) && step["name"] === "Evaluate CI outcome",
  );
  if (
    !isRecord(outcome) ||
    !isRecord(outcome["env"]) ||
    typeof outcome["env"]["FAST_REQUIRED"] !== "string"
  ) {
    return invalid("Expected normal PR required jobs");
  }
  const required: unknown = JSON.parse(outcome["env"]["FAST_REQUIRED"]);
  if (
    !Array.isArray(required) ||
    !required.every((job) => typeof job === "string")
  ) {
    return invalid("Invalid normal PR required jobs");
  }
  for (const job of required) {
    if (!Object.hasOwn(workflow["jobs"], job)) {
      return invalid(`Stale normal PR required job: ${job}`);
    }
  }
  const deferred = PILOT_DEFERRED.filter(
    (job) => required.includes(job) && !fast.jobs.includes(job),
  );
  return { status: "valid", jobs: deferred.toSorted() } as const;
};

if (import.meta.main) {
  const filename = process.argv.at(2);
  const queue = process.argv.at(3) === "queue";
  const classify = queue ? pilotQueueJobs : pilotFastJobs;
  const result = filename
    ? classify(Bun.YAML.parse(readFileSync(filename, "utf-8")))
    : invalid("Expected workflow filename");
  switch (result.status) {
    case "invalid":
      console.error(JSON.stringify(result));
      process.exitCode = 1;
      break;
    case "valid":
      console.log(
        `${queue ? "queue_jobs" : "fast_jobs"}=${JSON.stringify(result.jobs)}`,
      );
      break;
  }
}
