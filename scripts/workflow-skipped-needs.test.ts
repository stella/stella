import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A job without a status function in its `if` runs only when every job up its
// `needs` chain succeeded: one skipped ancestor skips it too, and the run can
// still conclude success. A job below a conditionally skipped job therefore
// states its own status function (`!cancelled()`, `always()`, ...) and names
// the results it depends on. Staging promotion was skipped this way whenever a
// release candidate found staging already running.
//
// The jobs listed here predate this check. Each one either intends to skip
// with its ancestor or needs the explicit condition; review and remove entries,
// never add one.
const REVIEW_PENDING = new Set([
  "autofix.yml#regenerate-derived-files",
  "ci.yml#api-image-smoke",
  "ci.yml#ci-checks-generated",
  "ci.yml#dependency-malware",
  "ci.yml#desktop-rust-tests",
  "ci.yml#desktop-windows-dry-run",
  "ci.yml#docker-checks",
  "ci.yml#e2e-vite-canary",
  "ci.yml#fix-tests-on-base",
  "ci.yml#generated-sources",
  "ci.yml#heavy-web-build",
  "ci.yml#landing-build",
  "ci.yml#legal-atlas-image",
  "ci.yml#migration-upgrade-rehearsal",
  "ci.yml#mobile-build",
  "ci.yml#pr-heavy-gate",
  "ci.yml#query-perf",
  "ci.yml#release-typecheck",
  "ci.yml#scan-engine-wasm-drift",
  "ci.yml#stack-redaction-browsers",
  "ci.yml#web-image-smoke",
  "ci.yml#windows-scripts",
  "deploy-landing.yml#build",
  "deploy-landing.yml#deploy",
  "deploy-staging.yml#staging-health",
  "deploy-staging.yml#staging-wake",
  "main-heavy.yml#suites",
  "network-baseline-record.yml#deliver",
  "network-baseline-record.yml#record",
  "publish-npm.yml#pack",
  "publish-npm.yml#release",
  "release-desktop.yml#build",
  "release-desktop.yml#carry-forward",
  "release-desktop.yml#verify-production",
  "release-pr.yml#version",
  "release-tag.yml#marketing-freshness",
  "release.yml#dispatch-release-health",
  "release.yml#promote",
  "user-journeys.yml#local-stack",
  "user-journeys.yml#staging",
]);

const WORKFLOWS = path.resolve(import.meta.dirname, "../.github/workflows");
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\(\)/u;

type Job = { needs?: unknown; if?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Jobs below a conditionally skipped job whose own `if` has no status function. */
export const implicitSuccessBelowSkippable = (
  file: string,
  jobs: Readonly<Record<string, Job>>,
): string[] => {
  const needs = (name: string): string[] => {
    const value = jobs[name]?.needs;
    if (typeof value === "string") {
      return [value];
    }
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  };
  const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
    for (const parent of needs(name)) {
      if (!seen.has(parent)) {
        seen.add(parent);
        ancestors(parent, seen);
      }
    }
    return seen;
  };
  return Object.keys(jobs)
    .filter((name) => {
      const condition = jobs[name]?.if;
      if (typeof condition === "string" && STATUS_FUNCTION.test(condition)) {
        return false;
      }
      return [...ancestors(name)].some(
        (ancestor) => jobs[ancestor]?.if !== undefined,
      );
    })
    .map((name) => `${file}#${name}`);
};

const workflowJobs = (file: string): Record<string, Job> => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(path.join(WORKFLOWS, file), "utf-8"),
  );
  const jobs = isRecord(parsed) ? parsed["jobs"] : undefined;
  return isRecord(jobs)
    ? Object.fromEntries(
        Object.entries(jobs).map(([name, job]) => [
          name,
          isRecord(job) ? job : {},
        ]),
      )
    : {};
};

test("a job below a conditionally skipped job states its own status function", () => {
  const found = readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/u.test(file))
    .toSorted()
    .flatMap((file) => implicitSuccessBelowSkippable(file, workflowJobs(file)));
  expect(found.filter((job) => !REVIEW_PENDING.has(job))).toEqual([]);
  // The list only shrinks: a fixed job leaves it.
  expect([...REVIEW_PENDING].filter((job) => !found.includes(job))).toEqual([]);
});

test("the check finds a skipped grandparent and accepts an explicit status function", () => {
  const jobs = {
    wake: { if: "inputs.wake" },
    build: { needs: ["wake"], if: "!cancelled()" },
    promote: { needs: ["build"], if: "github.ref == 'refs/heads/main'" },
    report: { needs: ["promote"] },
    fixed: {
      needs: ["build"],
      if: "!cancelled() && needs.build.result == 'success'",
    },
    plain: { needs: [] },
  };
  expect(implicitSuccessBelowSkippable("w.yml", jobs)).toEqual([
    "w.yml#promote",
    "w.yml#report",
  ]);
});
