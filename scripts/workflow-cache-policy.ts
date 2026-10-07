// This classification owns both cache prohibition and raw Bun setup eligibility.
// Existing cold-scanner wiring and explicit no-cache runtime inputs are contracts,
// not a separate list of exempt workflow/job names.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const triggers = (on: unknown): string[] => {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.filter((event): event is string => typeof event === "string");
  }
  return isRecord(on) ? Object.keys(on) : [];
};

// Release and deploy jobs restore caches from the default branch's scope.
// pull_request runs save only to their own pull request's scope, but
// pull_request_target and workflow_run runs save to the default branch's
// scope: a fork can influence the first, and the second runs release and
// signing jobs. So none of their jobs may save to or restore from any cache,
// and a reusable workflow they call must be one reviewed for that.
const DEFAULT_SCOPE_EVENTS = ["pull_request_target", "workflow_run"];
const REVIEWED_REUSABLE_WORKFLOWS: Record<string, string> = {
  "stella/.github/.github/workflows/pr-lint.yml@167fb396c6c0f4e07296ad2cd72e6ef15367c776":
    "title, label, size and assignee actions only; no cache",
  "stella/.github/.github/workflows/npm-independent-release.yml@167fb396c6c0f4e07296ad2cd72e6ef15367c776":
    "checkout, artifact download, setup-node with Bun manifests and no cache input, hardened publish action; no cache",
};

export const MAIN_ONLY_BUN_CACHE_SAVE = `\${{ github.ref == 'refs/heads/main' }}`;

/** Why a step can save to the Actions cache, or null when it cannot. */
const cacheSave = (step: Record<string, unknown>): string | null => {
  const uses = typeof step["uses"] === "string" ? step["uses"] : "";
  const inputs = isRecord(step["with"]) ? step["with"] : {};
  if (uses === "") {
    return null;
  }
  if (uses.startsWith("./")) {
    return `local action ${uses} is not reviewed for cache use`;
  }
  if (/^actions\/cache(\/save)?@/u.test(uses)) {
    return `${uses} saves a cache`;
  }
  if (/setup-bun-cached@|^Swatinem\/rust-cache@/u.test(uses)) {
    return `${uses} saves a cache`;
  }
  if (uses.startsWith("oven-sh/setup-bun@") && inputs["no-cache"] !== true) {
    return `${uses} caches the Bun binary unless no-cache is true`;
  }
  const setupGo = uses.startsWith("actions/setup-go@");
  if (setupGo && inputs["cache"] !== false) {
    return `${uses} caches by default unless cache is false`;
  }
  if (
    /^actions\/setup-[a-z]+@/u.test(uses) &&
    !setupGo &&
    inputs["cache"] !== undefined &&
    inputs["cache"] !== false &&
    inputs["cache"] !== ""
  ) {
    return `${uses} saves a cache through its cache input`;
  }
  return null;
};

type JobCachePolicyOptions = {
  workflow: unknown;
  job: Record<string, unknown>;
};
export const usesDefaultCacheScope = (workflow: unknown) =>
  isRecord(workflow) &&
  triggers(workflow["on"]).some((event) =>
    DEFAULT_SCOPE_EVENTS.includes(event),
  );

const hasPublishToken = (workflow: unknown, job: unknown) => {
  if (!isRecord(job)) {
    return false;
  }
  const permissions =
    job["permissions"] ??
    (isRecord(workflow) ? workflow["permissions"] : undefined);
  if (typeof permissions === "string") {
    return permissions !== "read-all";
  }
  return (
    isRecord(permissions) &&
    ["id-token", "contents", "packages"].some(
      (key) =>
        permissions[key] === "write" ||
        (typeof permissions[key] === "string" &&
          permissions[key].includes("${{")),
    )
  );
};

const hasArtifactStep = (job: unknown, operation: string) =>
  isRecord(job) &&
  Array.isArray(job["steps"]) &&
  job["steps"].some(
    (step: unknown) =>
      isRecord(step) &&
      typeof step["uses"] === "string" &&
      step["uses"].startsWith(`actions/${operation}-artifact@`),
  );

// Protect the full dependency chain of a publishing token. Artifact readers
// can consume uploads without a needs edge, so include those producers too.
const publishingJobNames = (workflow: unknown) => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return new Set<string>();
  }
  const jobs = workflow["jobs"];
  const protectedJobs = new Set(
    Object.keys(jobs).filter((name) => hasPublishToken(workflow, jobs[name])),
  );
  const pending = [...protectedJobs];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) {
      continue;
    }
    const job = jobs[name];
    if (!isRecord(job)) {
      continue;
    }
    const needs = job["needs"];
    const dependencies = Array.isArray(needs)
      ? needs.filter(
          (dependency): dependency is string => typeof dependency === "string",
        )
      : [];
    if (typeof needs === "string") {
      dependencies.push(needs);
    }
    if (hasArtifactStep(job, "download")) {
      dependencies.push(
        ...Object.keys(jobs).filter((candidate) =>
          hasArtifactStep(jobs[candidate], "upload"),
        ),
      );
    }
    if (hasArtifactStep(job, "upload")) {
      dependencies.push(
        ...Object.keys(jobs).filter((candidate) =>
          hasArtifactStep(jobs[candidate], "download"),
        ),
      );
    }
    for (const dependency of dependencies) {
      if (protectedJobs.has(dependency)) {
        continue;
      }
      if (!isRecord(jobs[dependency])) {
        continue;
      }
      protectedJobs.add(dependency);
      pending.push(dependency);
    }
  }
  return protectedJobs;
};

export const jobCachePolicy = ({ workflow, job }: JobCachePolicyOptions) => {
  if (usesDefaultCacheScope(workflow)) {
    return "default-scope";
  }
  const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
  if (
    steps.some(
      (step: unknown) =>
        isRecord(step) && step["uses"] === "./.github/actions/safe-chain",
    )
  ) {
    return "cold-install";
  }
  if (
    steps.some(
      (step: unknown) =>
        isRecord(step) &&
        typeof step["uses"] === "string" &&
        /(?:oven-sh\/setup-bun|stella\/\.github\/actions\/setup-bun-cached)@/u.test(
          step["uses"],
        ) &&
        isRecord(step["with"]) &&
        step["with"]["no-cache"] === true,
    )
  ) {
    return "no-cache";
  }
  if (
    hasPublishToken(workflow, job) ||
    (isRecord(workflow) &&
      isRecord(workflow["jobs"]) &&
      Object.entries(workflow["jobs"]).some(
        ([name, candidate]) =>
          candidate === job && publishingJobNames(workflow).has(name),
      ))
  ) {
    return "publish-chain";
  }
  return "install-cache";
};

export const workflowCacheProblems = (workflow: unknown): string[] => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return [];
  }
  return Object.entries(workflow["jobs"]).flatMap(([name, job]) => {
    if (!isRecord(job)) {
      return [];
    }
    const policy = jobCachePolicy({ workflow, job });
    const reusable = typeof job["uses"] === "string" ? job["uses"] : null;
    if (policy === "default-scope" && reusable !== null) {
      return reusable in REVIEWED_REUSABLE_WORKFLOWS
        ? []
        : [
            `job '${name}' calls ${reusable}, which is not reviewed for cache use`,
          ];
    }
    const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
    return steps.flatMap((step: unknown) => {
      if (!isRecord(step)) {
        return [];
      }
      const uses = typeof step["uses"] === "string" ? step["uses"] : "";
      const inputs = isRecord(step["with"]) ? step["with"] : {};
      if (
        uses.startsWith("stella/.github/actions/setup-bun-cached@") &&
        inputs["save"] !== MAIN_ONLY_BUN_CACHE_SAVE
      ) {
        return [`job '${name}': Bun install cache saves must be main-only`];
      }
      const path = typeof inputs["path"] === "string" ? inputs["path"] : "";
      const bunStore = path.split(/\r?\n/u).some((entry) => {
        const segments = entry.trim().split(/[\\/]/u).filter(Boolean);
        return segments.some((segment, index) => {
          if (segment !== ".bun") {
            return false;
          }
          if (index === segments.length - 1) {
            return true;
          }
          if (segments.at(index + 1) !== "install") {
            return false;
          }
          return (
            index === segments.length - 2 || segments.at(index + 2) === "cache"
          );
        });
      });
      if (bunStore && uses.startsWith("actions/cache@")) {
        return [`job '${name}': split Bun cache restore from main-only save`];
      }
      if (
        bunStore &&
        uses.startsWith("actions/cache/save@") &&
        step["if"] !== MAIN_ONLY_BUN_CACHE_SAVE
      ) {
        return [`job '${name}': Bun install cache saves must be main-only`];
      }
      if (policy === "install-cache") {
        return uses.startsWith("oven-sh/setup-bun@")
          ? [
              `job '${name}': raw Bun setup needs the shared install-cache action`,
            ]
          : [];
      }
      if (policy === "publish-chain") {
        return /setup-bun-cached@|^actions\/cache(?:\/[^@]+)?@/u.test(uses)
          ? [`job '${name}': ${uses} changes publishing dependency policy`]
          : [];
      }
      if (policy === "cold-install") {
        return /setup-bun-cached@|^actions\/cache(?:\/[^@]+)?@/u.test(uses)
          ? [`job '${name}': ${uses} bypasses cold registry downloads`]
          : [];
      }
      // Existing no-cache runtime jobs may use their local release helpers;
      // default-scope jobs keep the existing fail-closed local-action rule.
      const reason =
        policy === "no-cache" && uses.startsWith("./") ? null : cacheSave(step);
      return reason === null ? [] : [`job '${name}': ${reason}`];
    });
  });
};
