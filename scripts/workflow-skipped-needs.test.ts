import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A job without a status function in its `if` runs only when every job up its
// `needs` chain succeeded: one skipped ancestor skips it too. Skipping together
// with a parent is usually the intent. The hazard is a parent that states a
// status function (`!cancelled()`, `always()`, ...) so it still runs after a
// skipped ancestor, while its child does not: the parent does the work, the
// child silently skips, and the run can conclude success. Such a child states
// its own status function and the results it depends on.

const WORKFLOWS = path.resolve(import.meta.dirname, "../.github/workflows");
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\(\)/u;
// These let a job run after a skipped ancestor: `always()`, any `cancelled()`
// test (`!cancelled()`), and a negated `failure()` or `success()`. A plain
// `success()` skips with the ancestor; a plain `failure()` runs only after a
// failure.
const TOLERATES_SKIP =
  /\b(?:always|cancelled)\(\)|!\s*(?:failure|success)\(\)/u;

type Job = { needs?: unknown; if?: unknown };

/**
 * The `&&` operands of a condition outside parentheses and quotes, each with
 * whitespace collapsed; none when a `||` also sits at that level.
 */
const topLevelConjuncts = (condition: string): string[] => {
  const expression = condition
    .trim()
    .replace(/^\$\{\{(.*)\}\}$/su, "$1")
    .trim();
  const conjuncts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'") {
      quoted = !quoted;
    } else if (!quoted && char === "(") {
      depth += 1;
    } else if (!quoted && char === ")") {
      depth -= 1;
    } else if (!quoted && depth === 0) {
      const pair = expression.slice(index, index + 2);
      if (pair === "||") {
        return [];
      }
      if (pair === "&&") {
        conjuncts.push(expression.slice(start, index));
        start = index + 2;
        index += 1;
      }
    }
  }
  conjuncts.push(expression.slice(start));
  return conjuncts.map((part) => part.trim().replaceAll(/\s+/gu, " "));
};

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
  // A conditional job at or above `name` can skip, and so skip `name` too.
  const maySkip = (name: string) =>
    [name, ...ancestors(name)].some(
      (ancestor) => jobs[ancestor]?.if !== undefined,
    );
  // A top-level `needs.<need>.result == 'success'` conjunct skips the job
  // whenever that need skips. A guard under `||` or in parentheses may not be
  // required, so it does not count.
  const requiresSuccess = (name: string, need: string) => {
    const condition = jobs[name]?.if;
    const conjuncts =
      typeof condition === "string" ? topLevelConjuncts(condition) : [];
    return conjuncts.includes(`needs.${need}.result == 'success'`);
  };
  // The parent runs after a skip along some need: one it does not require to
  // succeed that can skip, or one it requires that itself survives a skip
  // and so succeeds with a skipped ancestor. Workflow needs form a DAG.
  const survivesSkip = (parent: string): boolean =>
    conditionMatches(parent, TOLERATES_SKIP) &&
    needs(parent).some((need) =>
      requiresSuccess(parent, need) ? survivesSkip(need) : maySkip(need),
    );
  return Object.keys(jobs)
    .filter(
      (name) =>
        !conditionMatches(name, STATUS_FUNCTION) &&
        needs(name).some(survivesSkip),
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
    // Requiring the skipped need's success skips the parent with it.
    guarded: {
      needs: ["wake"],
      if: "!cancelled() && needs.wake.result == 'success'",
    },
    package: { needs: ["guarded"] },
    // A success guard that is one alternative of several does not require it.
    either: {
      needs: ["wake"],
      if: "!cancelled() && (needs.wake.result == 'success' || needs.wake.result == 'skipped')",
    },
    ship: { needs: ["either"] },
    // A required need that itself survives the skip passes it on.
    stage: {
      needs: ["build"],
      if: "!cancelled() && needs.build.result == 'success'",
    },
    release: { needs: ["stage"] },
  };
  expect(skipsAfterTolerantParent("w.yml", jobs)).toEqual([
    "w.yml#promote",
    "w.yml#publish",
    "w.yml#ship",
    "w.yml#release",
  ]);
});
