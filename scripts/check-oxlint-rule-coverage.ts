import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../oxlint.config.ts";
import {
  createFileIndex,
  isRecord,
  LINTED_FILE_PATTERN,
  matches,
  readScopes,
  repoRoot,
  ruleIsOff,
  stringArray,
  trackedRepoFiles,
} from "./oxlint-config-scopes.ts";

export type CoverageProblem = {
  ruleId: string;
  category: "unwired" | "empty-scope" | "untested";
};

export const exportedRuleIds = (plugin: unknown): string[] => {
  if (
    !isRecord(plugin) ||
    !isRecord(plugin["meta"]) ||
    typeof plugin["meta"]["name"] !== "string" ||
    !isRecord(plugin["rules"])
  ) {
    return panic("Custom plugin must export meta.name and rules");
  }
  const pluginName = plugin["meta"]["name"];
  return Object.keys(plugin["rules"]).map((rule) => `${pluginName}/${rule}`);
};

export const readCoverage = (text: string): Map<string, Set<string>> => {
  const coverage = new Map<string, Set<string>>();
  for (const line of text.split("\n").filter(Boolean)) {
    const entry: unknown = JSON.parse(line);
    if (
      !isRecord(entry) ||
      typeof entry["ruleId"] !== "string" ||
      (entry["outcome"] !== "clean" && entry["outcome"] !== "report")
    ) {
      return panic("Invalid executed rule coverage record");
    }
    const outcomes = coverage.get(entry["ruleId"]) ?? new Set<string>();
    outcomes.add(entry["outcome"]);
    coverage.set(entry["ruleId"], outcomes);
  }
  return coverage;
};

type CoverageProblemsOptions = {
  ruleIds: readonly string[];
  registeredRuleIds: ReadonlySet<string>;
  lintConfig: unknown;
  trackedFiles: readonly string[];
  coverage: ReadonlyMap<string, ReadonlySet<string>>;
};

export const coverageProblems = ({
  ruleIds,
  registeredRuleIds,
  lintConfig,
  trackedFiles,
  coverage,
}: CoverageProblemsOptions): CoverageProblem[] => {
  const ignores = isRecord(lintConfig)
    ? stringArray(lintConfig["ignorePatterns"])
    : [];
  const files = trackedFiles.filter(
    (file) =>
      LINTED_FILE_PATTERN.test(file) &&
      !ignores.some((pattern) =>
        matches(pattern.endsWith("/") ? `${pattern}**` : pattern, file),
      ),
  );
  const index = createFileIndex(files);
  const scopes = readScopes(lintConfig);
  const effective = new Map<string, Set<string>>();
  const configured = new Set<string>();
  const known = new Set(ruleIds);
  for (const scope of scopes) {
    const entries = Object.entries(scope.rules).filter(([rule]) =>
      known.has(rule),
    );
    if (entries.length === 0) {
      continue;
    }
    const reached = index.scopeFiles(scope);
    for (const [rule, value] of entries) {
      if (!ruleIsOff(value)) {
        configured.add(rule);
      }
      const enabled = effective.get(rule) ?? new Set<string>();
      for (const file of reached) {
        if (ruleIsOff(value)) {
          enabled.delete(file);
        } else {
          enabled.add(file);
        }
      }
      effective.set(rule, enabled);
    }
  }
  const problems: CoverageProblem[] = [];
  for (const ruleId of ruleIds) {
    if (!registeredRuleIds.has(ruleId) || !configured.has(ruleId)) {
      problems.push({ ruleId, category: "unwired" });
    } else if ((effective.get(ruleId)?.size ?? 0) === 0) {
      problems.push({ ruleId, category: "empty-scope" });
    }
    const outcomes = coverage.get(ruleId);
    if (!outcomes?.has("report") || !outcomes.has("clean")) {
      problems.push({ ruleId, category: "untested" });
    }
  }
  return problems;
};

export const problemKey = ({ ruleId, category }: CoverageProblem): string =>
  `${ruleId}::${category}`;

const REMEDIATION: Record<CoverageProblem["category"], string> = {
  unwired: "register the plugin and configure the rule",
  "empty-scope": "give the rule at least one linted file",
  untested: "add reporting and clean test cases",
};

/** Every custom rule must be wired, scoped and tested; there is no allowance. */
export const coverageErrors = (
  problems: readonly CoverageProblem[],
): string[] =>
  problems.map(
    (problem) =>
      `Custom rule coverage gap: ${problemKey(problem)} (${REMEDIATION[problem.category]})`,
  );

export const repositoryRules = async () => {
  // Enumerate all tracked top-level modules, including plugins absent from config.
  const ruleIds: string[] = [];
  const registeredRuleIds = new Set<string>();
  const registeredModules = new Set(
    stringArray(config.jsPlugins).map((file) => path.resolve(repoRoot, file)),
  );
  for (const file of trackedRepoFiles().filter((candidate) =>
    /^\.oxlint-plugins\/[^/]+\.ts$/u.test(candidate),
  )) {
    const module = await import(path.join(repoRoot, file));
    if (module.default === undefined) {
      continue;
    }
    const exported = exportedRuleIds(module.default);
    ruleIds.push(...exported);
    if (registeredModules.has(path.join(repoRoot, file))) {
      for (const ruleId of exported) {
        registeredRuleIds.add(ruleId);
      }
    }
  }
  if (ruleIds.length === 0 || new Set(ruleIds).size !== ruleIds.length) {
    return panic("Custom rule census is empty or contains duplicate IDs");
  }
  return { ruleIds: ruleIds.toSorted(), registeredRuleIds };
};

export const CUSTOM_LINT_TEST_ARGS = [
  "test",
  "./.oxlint-plugins/__tests__",
] as const;

const main = async (): Promise<number> => {
  const directory = mkdtempSync(path.join(tmpdir(), "oxlint-rule-coverage-"));
  const coveragePath = path.join(directory, "coverage.jsonl");
  try {
    const tests = Bun.spawnSync([process.execPath, ...CUSTOM_LINT_TEST_ARGS], {
      cwd: repoRoot,
      env: { ...process.env, OXLINT_RULE_COVERAGE_PATH: coveragePath },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!tests.success) {
      return 1;
    }
    const problems = coverageProblems({
      ...(await repositoryRules()),
      lintConfig: config,
      trackedFiles: trackedRepoFiles(),
      coverage: readCoverage(readFileSync(coveragePath, "utf-8")),
    });
    const errors = coverageErrors(problems);
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0) {
      return 1;
    }
    console.log(
      "Custom rule coverage OK (every rule wired, scoped and tested).",
    );
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
