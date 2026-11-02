import { panic, Result } from "better-result";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import type { GatedTestSelection } from "../apps/api/scripts/gated-test-selection";
import { discoverGatedTestFiles } from "../apps/api/scripts/run-gated-tests";
import { API_ALL_RULES, selectApiTestImpact } from "./api-test-impact";
import { hasDeclaredMarkdownReader } from "./ci-package-scope";
import { encodePostgresTestSelection } from "./plan-output-codec";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const PLANNER_ENTRY = "scripts/ci-postgres-test-plan.ts";
const CODE_FILE = /\.[cm]?[jt]sx?$/u;

/**
 * Repository files this planner loads, followed through relative and
 * workspace imports. A change to any of them changes the planner itself, so
 * it must not be judged by its own (changed) verdict, and no allow-list has
 * to remember the planner's helpers.
 */
export const plannerSourceFiles = (root = repositoryRoot) => {
  const realRoot = realpathSync(root);
  const files = new Set<string>();
  const pending = [PLANNER_ENTRY];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    if (!CODE_FILE.test(file)) {
      continue;
    }
    const absolute = path.join(realRoot, file);
    const transpiler = new Bun.Transpiler({
      loader: file.endsWith("x") ? "tsx" : "ts",
    });
    const source = readFileSync(absolute, "utf-8").replace(/^#!.*/u, "");
    for (const { path: specifier } of transpiler.scanImports(source)) {
      const resolved = Bun.resolveSync(specifier, path.dirname(absolute));
      // Built-in modules resolve to their own specifier.
      if (!path.isAbsolute(resolved)) {
        continue;
      }
      const real = realpathSync(resolved);
      if (!isPathInside(realRoot, real)) {
        continue;
      }
      const relative = repoRelativePath(realRoot, real);
      if (relative.split("/").includes("node_modules")) {
        continue;
      }
      pending.push(relative);
    }
  }
  return files;
};

export const POSTGRES_NO_IMPACT_PATHS = {
  changesets: {
    pattern: /^\.changeset\/.*\.md$/u,
    reason: "Release metadata is not read by Postgres suites.",
  },
  agentInstructions: {
    pattern: /^(?:\.agents|\.claude)\//u,
    reason: "Agent and skill instructions are not runtime inputs.",
  },
  cloudReport: {
    pattern: /^CLOUD_REPORT\.md$/u,
    reason: "Cloud handoff evidence is not a runtime input.",
  },
  repositoryTooling: {
    pattern: /^scripts\/.*\.(?:[cm]?[jt]s|[jt]sx)$/u,
    reason:
      "Repository tooling outside the selector allow-list is not imported by API suites.",
  },
  documentation: {
    pattern: /^docs\/.*\.mdx?$/u,
    reason:
      "Documentation not owned by a declared Markdown reader is not a runtime input.",
  },
} as const;

const hasApiWideningRule = (file: string) =>
  Object.values(API_ALL_RULES).some((rule) => rule.test(file));

const isPostgresNoImpactPath = (file: string, root: string) => {
  if (hasApiWideningRule(file)) {
    return false;
  }
  for (const [name, { pattern }] of Object.entries(POSTGRES_NO_IMPACT_PATHS)) {
    if (!pattern.test(file)) {
      continue;
    }
    return name !== "documentation" || !hasDeclaredMarkdownReader(file, root);
  }
  return false;
};

type AssertPostgresDiscoveryOptions = {
  discovered: readonly string[];
  gated: readonly string[];
  selectorFiles: readonly string[];
};

export const assertPostgresDiscovery = ({
  discovered,
  gated,
  selectorFiles,
}: AssertPostgresDiscoveryOptions) => {
  const selectable = new Set(selectorFiles);
  const runners = new Set(discovered);
  const expected = new Set(gated);
  const missing = gated.filter(
    (file) => !selectable.has(file) || !runners.has(file),
  );
  const stale = discovered.filter((file) => !expected.has(file));
  if (gated.length === 0 || missing.length > 0 || stale.length > 0) {
    panic(
      `Postgres discovery mismatch: missing=${missing.join(",")}; stale=${stale.join(",")}; gated=${gated.length}`,
    );
  }
};

type PlanPostgresTestsOptions = {
  event: string;
  scopeUnknown: boolean;
  changed: readonly string[];
  root?: string;
};

export const planPostgresTests = async ({
  event,
  scopeUnknown,
  changed,
  root = repositoryRoot,
}: PlanPostgresTestsOptions): Promise<GatedTestSelection> => {
  if (
    (event !== "merge_group" && event !== "pull_request") ||
    scopeUnknown ||
    changed.length === 0
  ) {
    return { mode: "all" };
  }

  const planned = await Result.tryPromise(async () => {
    const plannerFiles = plannerSourceFiles();
    if (changed.some((file) => plannerFiles.has(file))) {
      return { mode: "all" } as const;
    }

    // Only named, non-runtime paths may bypass the conservative outside-graph
    // guard. Markdown ownership remains authoritative for documentation read
    // by code, and selector tooling retains its explicit widening rules.
    if (
      changed.some(
        (file) =>
          !isPostgresNoImpactPath(file, root) &&
          !hasApiWideningRule(file) &&
          !file.startsWith(".github/") &&
          !/^(?:apps|packages)\/[^/]+\/.+\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file),
      )
    ) {
      return { mode: "all" } as const;
    }

    const apiRoot = path.join(root, "apps/api");
    const metadata = v.parse(
      v.object({
        ciGateTestRunners: v.object({
          "test:postgres": v.object({
            gate: v.string(),
            testFileGlob: v.string(),
          }),
        }),
      }),
      JSON.parse(readFileSync(path.join(apiRoot, "package.json"), "utf-8")),
    );
    const runner = metadata.ciGateTestRunners["test:postgres"];
    if (runner.gate !== "STELLA_RUN_POSTGRES_TESTS") {
      panic("Unexpected Postgres test gate");
    }
    const selectorFiles = listApiTestPaths(apiRoot);
    const gated = selectorFiles.filter((file) =>
      readFileSync(path.join(apiRoot, file), "utf-8").includes(runner.gate),
    );
    const discovered = await discoverGatedTestFiles({ apiRoot, ...runner });
    assertPostgresDiscovery({ discovered, gated, selectorFiles });
    const impact = selectApiTestImpact({
      root,
      changed,
      graphFailurePolicy: "all",
    });
    switch (impact.mode) {
      case "all":
        return { mode: "all" } as const;
      case "none":
        return { mode: "none" } as const;
      case "selected": {
        const postgres = new Set(discovered);
        const files = impact.files.filter((file) => postgres.has(file));
        return files.length === 0
          ? ({ mode: "none" } as const)
          : ({ mode: "selected", files } as const);
      }
      default:
        impact.mode satisfies never;
        return panic("Unhandled API test impact mode");
    }
  });
  if (planned.isErr()) {
    console.warn(
      "Postgres selection unavailable; running the full suite.",
      planned.error,
    );
    return { mode: "all" };
  }
  return planned.value;
};

if (import.meta.main) {
  const input = Result.try(() =>
    readFileSync(
      path.join(
        process.env["RUNNER_TEMP"] ?? panic("Missing RUNNER_TEMP"),
        "api-test-changed-paths",
      ),
      "utf-8",
    )
      .split("\0")
      .filter(Boolean),
  );
  const selection = input.isErr()
    ? ({ mode: "all" } as const)
    : await planPostgresTests({
        event: process.env["EVENT_NAME"] ?? "",
        scopeUnknown: process.env["API_SCOPE_UNKNOWN"] !== "false",
        changed: input.value,
      });
  const reasons = {
    all: "Full coverage retained: event policy, widening rule, or uncertain analysis.",
    none: "No Postgres files affected by the changed runtime import graph.",
    selected: "Postgres files reachable from the changed runtime import graph.",
  } as const satisfies Record<GatedTestSelection["mode"], string>;
  appendFileSync(
    process.env["GITHUB_OUTPUT"] ?? panic("Missing GITHUB_OUTPUT"),
    `postgres_test_selection_encoded=${encodePostgresTestSelection(selection)}\npostgres_selection_reason=${reasons[selection.mode]}\n`,
  );
}
