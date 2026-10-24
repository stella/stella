import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A job without a status function in its `if` runs only when every job up its
// `needs` chain succeeded: one skipped ancestor skips it too. Skipping together
// with a parent is usually the intent. The hazard is a parent that states a
// status function (`!cancelled()`, `always()`, ...) so it still runs after a
// skipped ancestor, while its child does not: the parent does the work, the
// child silently skips, and the run can conclude success. Staging promotion
// was skipped this way whenever a release candidate found staging running.
// Such a child states its own status function and the results it depends on.

const WORKFLOWS = path.resolve(import.meta.dirname, "../.github/workflows");
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\(\)/u;
// These let a job run after a skipped ancestor: `always()`, any `cancelled()`
// test (`!cancelled()`), and a negated `failure()` or `success()`. A plain
// `success()` skips with the ancestor; a plain `failure()` runs only after a
// failure.
const TOLERATES_SKIP =
  /\b(?:always|cancelled)\(\)|!\s*(?:failure|success)\(\)/u;

type Job = { needs?: unknown; if?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Jobs without a status function that need a parent which states one and sits
 * below a conditionally skipped job.
 */
export const skipsAfterTolerantParent = (
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
  const conditionMatches = (name: string, pattern: RegExp) => {
    const condition = jobs[name]?.if;
    return typeof condition === "string" && pattern.test(condition);
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
    .filter(
      (name) =>
        !conditionMatches(name, STATUS_FUNCTION) &&
        needs(name).some(
          (parent) =>
            conditionMatches(parent, TOLERATES_SKIP) &&
            [...ancestors(parent)].some(
              (ancestor) => jobs[ancestor]?.if !== undefined,
            ),
        ),
    )
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

test("no job silently skips below a parent that runs after a skipped ancestor", () => {
  expect(
    readdirSync(WORKFLOWS)
      .filter((file) => /\.ya?ml$/u.test(file))
      .toSorted()
      .flatMap((file) => skipsAfterTolerantParent(file, workflowJobs(file))),
  ).toEqual([]);
});

test("the check finds the child of a tolerant parent and nothing that skips with its parent", () => {
  const jobs = {
    wake: { if: "inputs.wake" },
    build: { needs: ["wake"], if: "!cancelled()" },
    // Runs after the tolerated skip only if it says so.
    promote: { needs: ["build"], if: "github.ref == 'refs/heads/main'" },
    fixed: {
      needs: ["build"],
      if: "!cancelled() && needs.build.result == 'success'",
    },
    // Skips together with its parent, as intended.
    scope: { if: "github.ref == 'refs/heads/main'" },
    deploy: { needs: ["scope"] },
    report: { needs: ["deploy"] },
    // An explicit success() parent skips with the ancestor too.
    gated: { needs: ["wake"], if: "success()" },
    summary: { needs: ["gated"] },
    // A negated failure() runs after the skip, so its child must say so.
    lenient: { needs: ["wake"], if: "!failure()" },
    publish: { needs: ["lenient"] },
  };
  expect(skipsAfterTolerantParent("w.yml", jobs)).toEqual([
    "w.yml#promote",
    "w.yml#publish",
  ]);
});
