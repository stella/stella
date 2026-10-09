import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { parseQueryPerfBaselineFile } from "../apps/api/src/tests/query-perf/baseline";

const BASELINE_PATH = "apps/api/src/tests/query-perf/baseline.json";
const ALLOWANCE_DIRECTORY = "scripts/query-perf-allowances";
const root = path.resolve(import.meta.dir, "..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const git = (args: string[], repositoryRoot = root) => {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return panic(
      `Query perf baseline git ${args.at(0)} failed: ${result.stderr}`,
    );
  }
  return result.stdout;
};

export const parseQueryPerfBaseline = (value: unknown) => {
  const baseline = parseQueryPerfBaselineFile(value);
  return Object.fromEntries(
    Object.entries(baseline.entries).map(
      ([id, metrics]) =>
        [
          id,
          {
            sharedBlocks: metrics.sharedBlocks,
            executionTimeUs: Math.round(metrics.executionTimeMs * 1000),
          },
        ] as const,
    ),
  );
};

type Allowance = {
  metric: "query-perf-shared-blocks" | "query-perf-execution-time-us";
  file: string;
  delta: number;
  reason: string;
};
export const parseQueryPerfAllowance = (value: unknown): Allowance => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["metric", "file", "delta", "reason"].includes(key),
    ) ||
    (value["metric"] !== "query-perf-shared-blocks" &&
      value["metric"] !== "query-perf-execution-time-us") ||
    typeof value["file"] !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value["file"]) ||
    typeof value["delta"] !== "number" ||
    !Number.isSafeInteger(value["delta"]) ||
    value["delta"] <= 0 ||
    typeof value["reason"] !== "string" ||
    value["reason"].trim().length === 0
  ) {
    return panic(
      "Query perf allowance requires metric, entry file, positive integer delta, nonempty reason and no unknown keys",
    );
  }
  return {
    metric: value["metric"],
    file: value["file"],
    delta: value["delta"],
    reason: value["reason"],
  };
};

export const queryPerfBaselineViolations = ({
  base,
  head,
  allowances,
}: {
  base: ReturnType<typeof parseQueryPerfBaseline>;
  head: ReturnType<typeof parseQueryPerfBaseline>;
  allowances: readonly Allowance[];
}) => {
  const increases = new Map<string, number>();
  for (const [id, prior] of Object.entries(base)) {
    const current = head[id];
    if (current === undefined) {
      return [
        `Query perf entry ${id} removed; registry coverage cannot silently shrink`,
      ];
    }
    for (const [field, metric] of [
      ["sharedBlocks", "query-perf-shared-blocks"],
      ["executionTimeUs", "query-perf-execution-time-us"],
    ] as const) {
      const delta = current[field] - prior[field];
      if (delta > 0) {
        increases.set(JSON.stringify([id, metric]), delta);
      }
    }
  }
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const allowance of allowances) {
    const key = JSON.stringify([allowance.file, allowance.metric]);
    if (seen.has(key)) {
      violations.push(`Duplicate query perf allowance ${key}`);
    }
    seen.add(key);
    if (increases.get(key) !== allowance.delta) {
      violations.push(
        `Query perf allowance ${key} must match the exact baseline increase`,
      );
    }
  }
  for (const [key, delta] of increases) {
    if (!seen.has(key)) {
      violations.push(
        `Query perf baseline increase ${key} (${delta}) needs a PR-scoped allowance with a reason`,
      );
    }
  }
  return violations;
};

type CheckQueryPerfBaselineOptions = {
  baseRef: string;
  repositoryRoot?: string;
};

export const checkQueryPerfBaseline = ({
  baseRef,
  repositoryRoot = root,
}: CheckQueryPerfBaselineOptions) => {
  // Treat a newly introduced baseline as bootstrap, never a missing old file as empty.
  const basePaths = new Set(
    git(["ls-tree", "-r", "--name-only", baseRef], repositoryRoot)
      .trim()
      .split("\n"),
  );
  const head = parseQueryPerfBaseline(
    JSON.parse(readFileSync(path.join(repositoryRoot, BASELINE_PATH), "utf-8")),
  );
  const base = basePaths.has(BASELINE_PATH)
    ? parseQueryPerfBaseline(
        JSON.parse(
          git(["show", `${baseRef}:${BASELINE_PATH}`], repositoryRoot),
        ),
      )
    : {};
  const allowances: Allowance[] = [];
  if (existsSync(path.join(repositoryRoot, ALLOWANCE_DIRECTORY))) {
    for (const name of readdirSync(
      path.join(repositoryRoot, ALLOWANCE_DIRECTORY),
    )) {
      if (name === "README.md") {
        continue;
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(name)) {
        return panic("Query perf allowances must use slug.json filenames");
      }
      const file = `${ALLOWANCE_DIRECTORY}/${name}`;
      const current = readFileSync(path.join(repositoryRoot, file), "utf-8");
      const parsed = parseQueryPerfAllowance(JSON.parse(current));
      // The ratchet convention: inherited declarations are inert; only this PR's delta applies.
      if (
        basePaths.has(file) &&
        git(["show", `${baseRef}:${file}`], repositoryRoot) === current
      ) {
        continue;
      }
      allowances.push(parsed);
    }
  }
  const violations = queryPerfBaselineViolations({ base, head, allowances });
  if (violations.length !== 0) {
    return panic(violations.join("\n"));
  }
};

if (import.meta.main) {
  if (process.argv.at(2) === "--validate") {
    parseQueryPerfBaselineFile(
      JSON.parse(readFileSync(path.join(root, BASELINE_PATH), "utf-8")),
    );
  } else {
    const baseRef = process.argv.at(2) ?? process.env["QUERY_PERF_BASE_REF"];
    if (baseRef === undefined) {
      panic("Query perf baseline requires an explicit base ref");
    }
    checkQueryPerfBaseline({ baseRef });
  }
}
