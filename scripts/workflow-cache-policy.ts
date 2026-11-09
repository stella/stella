// This classification owns both cache prohibition and raw Bun setup eligibility.
// Cold-scanner wiring and explicit no-cache runtime inputs are contracts; where
// a no-cache input or a raw Bun setup is allowed outside the structural rules,
// the job is listed below with the reason.
import { flattenWorkflowSteps } from "./workflow-steps";

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
  "stella/.github/.github/workflows/pr-lint.yml@5764ab66e4df84cfd2e642c7d7e4678261e668f8":
    "title, label, size and assignee actions only; no cache",
  "stella/.github/.github/workflows/npm-independent-release.yml@042baebaf071329b956555c05caf5736504c278d":
    "checkout, artifact download, setup-node without a cache input, hardened publish action from the pinned release-tooling checkout; no cache",
};
const DESKTOP_WINDOWS_BUILD_CACHE_USE =
  "baptiste0928/cargo-install caches installed Rust binaries";
const REVIEWED_LOCAL_ACTIONS: Record<string, string> = {
  "./.github/actions/desktop-windows-build": DESKTOP_WINDOWS_BUILD_CACHE_USE,
  "./.github/actions/ci-install":
    "exact scoped store restore; save only after a successful frozen install on main",
  // release-desktop restores the same action from the workflow revision
  // because the pinned release checkout replaces the workspace.
  "./.release-tooling/desktop-windows-build": DESKTOP_WINDOWS_BUILD_CACHE_USE,
};

export const MAIN_ONLY_BUN_CACHE_SAVE = `\${{ github.ref == 'refs/heads/main' }}`;

// oven-sh/setup-bun caches only the Bun executable; it has no package cache.
// Its `no-cache: true` therefore skips no package store: it makes every run
// download Bun from GitHub releases, so a releases outage fails the job.
// Default-scope and publish-chain jobs may set it by structure. Other jobs
// may set it only when they must restore no cache at all, listed here with
// why. Keys are `<repo-relative file>#<job id>`; a composite action's job id
// is `composite`.
const CACHE_FREE_BUN_JOBS: Record<string, string> = {
  ".github/actions/build-web-image/action.yml#composite":
    "builds the web image that release and deploy jobs publish",
  ".github/workflows/generated-conflicts-publish.yml#publish":
    "holds the generated-conflicts push key",
  ".github/workflows/main-heavy.yml#validate":
    "runs the release queue history check from the trusted release-proof checkout",
  ".github/workflows/main-pr-depth.yml#validate":
    "runs the release queue history check from the trusted release-proof checkout",
  ".github/workflows/mobile-release-plan.yml#plan":
    "plans which mobile builds a release ships",
  ".github/workflows/network-baseline-deliver.yml#deliver":
    "validates and publishes the immutable main network recording",
  ".github/workflows/release-mobile-ios.yml#testflight":
    "builds the iOS app shipped to TestFlight",
  ".github/workflows/release-rehearsal.yml#rehearse":
    "rehearses the release from the release revision",
};

// Ordinary jobs set Bun up through the shared install owner unless listed
// here with why they need no shared package store.
const UNSTORED_BUN_JOBS: Record<string, string> = {
  ".github/workflows/autofix.yml#regenerate-scope": "installs nothing",
  ".github/workflows/ci.yml#dependency-review":
    "parses workflow YAML and installs nothing",
  ".github/workflows/ci.yml#postgres-service-suites":
    "its filtered API/CLI install (8-13 s in run 38089283216) is cheaper than a store restore",
  ".github/workflows/fetch-public-documents.yml#fetch": "installs nothing",
  ".github/workflows/case-law-search-probe.yml#probe": "installs nothing",
  ".github/workflows/journey-canary.yml#journeys": "installs nothing",
  ".github/workflows/mobile-fingerprint-check.yml#fingerprint":
    "installs the mobile closure of both the merge result and its base",
  ".github/workflows/mobile-fingerprint-check.yml#fingerprint-macos":
    "installs the mobile closure of the merge result on macOS",
};

const setsBunNoCache = (step: unknown) =>
  isRecord(step) &&
  typeof step["uses"] === "string" &&
  step["uses"].startsWith("oven-sh/setup-bun@") &&
  isRecord(step["with"]) &&
  step["with"]["no-cache"] === true;

/** Why a step can save to the Actions cache, or null when it cannot. */
const cacheSave = (step: Record<string, unknown>): string | null => {
  const uses = typeof step["uses"] === "string" ? step["uses"] : "";
  const inputs = isRecord(step["with"]) ? step["with"] : {};
  if (uses === "") {
    return null;
  }
  const localUses = uses.startsWith("$/") ? `./${uses.slice(2)}` : uses;
  if (localUses.startsWith("./")) {
    return localUses in REVIEWED_LOCAL_ACTIONS
      ? null
      : `local action ${uses} is not reviewed for cache use`;
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
  flattenWorkflowSteps(job["steps"]).some(
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
  const steps = flattenWorkflowSteps(job["steps"] ?? []);
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
  if (inPublishChain(workflow, job)) {
    return "publish-chain";
  }
  return "install-cache";
};

const inPublishChain = (workflow: unknown, job: Record<string, unknown>) =>
  hasPublishToken(workflow, job) ||
  (isRecord(workflow) &&
    isRecord(workflow["jobs"]) &&
    Object.entries(workflow["jobs"]).some(
      ([name, candidate]) =>
        candidate === job && publishingJobNames(workflow).has(name),
    ));

type BunSetupReview = { problems: string[]; exemptions: string[] };

// `file` is the repo-relative workflow or composite action path; without it
// (fixtures) no listed exemption applies.
const reviewBunSetup = (
  workflow: unknown,
  name: string,
  job: Record<string, unknown>,
  file: string | undefined,
): BunSetupReview => {
  const steps = flattenWorkflowSteps(job["steps"] ?? []);
  const key = file === undefined ? undefined : `${file}#${name}`;
  const review: BunSetupReview = { problems: [], exemptions: [] };
  if (
    steps.some(setsBunNoCache) &&
    !usesDefaultCacheScope(workflow) &&
    !inPublishChain(workflow, job)
  ) {
    if (key !== undefined && key in CACHE_FREE_BUN_JOBS) {
      review.exemptions.push(key);
    } else {
      review.problems.push(
        `job '${name}': oven-sh/setup-bun no-cache: true only turns off the cached Bun executable (setup-bun has no package cache), so every run downloads Bun from GitHub releases and fails whenever they do; drop it, or list the job in CACHE_FREE_BUN_JOBS (scripts/workflow-cache-policy.ts) with why it must restore no cache`,
      );
    }
  }
  if (
    jobCachePolicy({ workflow, job }) === "install-cache" &&
    steps.some(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith("oven-sh/setup-bun@"),
    ) &&
    !steps.some(
      (step) =>
        step["uses"] === "$/.github/actions/ci-install" ||
        step["uses"] === "./.github/actions/ci-install",
    )
  ) {
    if (key !== undefined && key in UNSTORED_BUN_JOBS) {
      review.exemptions.push(key);
    } else {
      review.problems.push(
        `job '${name}': raw Bun setup needs the shared install-cache action`,
      );
    }
  }
  return review;
};

/** Listed Bun setup exemptions the committed workflow or action still needs. */
export const usedBunSetupExemptions = (file: string, workflow: unknown) =>
  !isRecord(workflow) || !isRecord(workflow["jobs"])
    ? []
    : Object.entries(workflow["jobs"]).flatMap(([name, job]) =>
        isRecord(job)
          ? reviewBunSetup(workflow, name, job, file).exemptions
          : [],
      );

export const BUN_SETUP_EXEMPTIONS = [
  ...Object.keys(CACHE_FREE_BUN_JOBS),
  ...Object.keys(UNSTORED_BUN_JOBS),
];

export const workflowCacheProblems = (
  workflow: unknown,
  file?: string,
): string[] => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return [];
  }
  return Object.entries(workflow["jobs"]).flatMap(([name, job]) => {
    if (!isRecord(job)) {
      return [];
    }
    const bunSetup = reviewBunSetup(workflow, name, job, file).problems;
    const policy = jobCachePolicy({ workflow, job });
    const reusable = typeof job["uses"] === "string" ? job["uses"] : null;
    if (policy === "default-scope" && reusable !== null) {
      return reusable in REVIEWED_REUSABLE_WORKFLOWS
        ? []
        : [
            `job '${name}' calls ${reusable}, which is not reviewed for cache use`,
          ];
    }
    const steps = flattenWorkflowSteps(job["steps"] ?? []);
    const stepProblems = steps.flatMap((step: unknown) => {
      if (!isRecord(step)) {
        return [];
      }
      const uses = typeof step["uses"] === "string" ? step["uses"] : "";
      const inputs = isRecord(step["with"]) ? step["with"] : {};
      if (
        [
          "$/.github/actions/ci-install",
          "./.github/actions/ci-install",
        ].includes(uses) &&
        policy !== "install-cache"
      ) {
        return [
          `job '${name}': scoped install cache is forbidden by ${policy} policy`,
        ];
      }
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
        // reviewBunSetup owns raw Bun setup in ordinary jobs.
        return [];
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
    return [...bunSetup, ...stepProblems];
  });
};
