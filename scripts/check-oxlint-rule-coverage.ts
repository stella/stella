import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../oxlint.config.ts";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";
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

export const parseCoverageBaseline = (text: string): Record<string, string> => {
  const baseline: unknown = JSON.parse(text);
  if (
    !isRecord(baseline) ||
    Object.entries(baseline).some(
      ([key, reason]) =>
        !/^[^/]+\/[^:]+::(?:unwired|empty-scope|untested)$/u.test(key) ||
        typeof reason !== "string" ||
        reason.trim().length === 0,
    )
  ) {
    return panic(
      "Rule coverage baseline must map rule/category keys to nonempty reasons",
    );
  }
  return Object.fromEntries(
    Object.entries(baseline).map(([key, reason]) => [key, String(reason)]),
  );
};

export const baselineErrors = (
  problems: readonly CoverageProblem[],
  baseline: Record<string, string>,
): string[] => {
  const current = new Set(problems.map(problemKey));
  return [
    ...[...current]
      .filter((key) => !(key in baseline))
      .map((key) => `Missing control: ${key}`),
    ...Object.keys(baseline)
      .filter((key) => !current.has(key))
      .map((key) => `Remove resolved baseline entry: ${key}`),
  ];
};

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

export const initialBaselineErrors = (
  baseline: Record<string, string>,
  baseRuleIds: readonly string[],
): string[] => {
  const existing = new Set(baseRuleIds);
  return Object.keys(baseline)
    .filter((key) => !existing.has(key.split("::").at(0) ?? ""))
    .map((key) => `New rules cannot enter the baseline: ${key}`);
};

export const readBaseRules = async (base: string): Promise<string[]> => {
  const directory = mkdtempSync(path.join(tmpdir(), "oxlint-base-rules-"));
  try {
    const archivePath = path.join(directory, "plugins.tar");
    const archive = Bun.spawnSync(["git", "archive", base, ".oxlint-plugins"], {
      cwd: repoRoot,
      stdout: Bun.file(archivePath),
      stderr: "pipe",
    });
    if (!archive.success) {
      return panic(
        `Cannot enumerate base plugins: ${archive.stderr.toString()}`,
      );
    }
    const extracted = Bun.spawnSync(
      ["tar", "-xf", archivePath, "-C", directory],
      { stderr: "pipe" },
    );
    if (!extracted.success) {
      return panic(
        `Cannot extract base plugins: ${extracted.stderr.toString()}`,
      );
    }
    for (const dependency of [
      "node_modules",
      "scripts",
      ".claude",
      "apps",
      "packages",
    ]) {
      symlinkSync(
        path.join(repoRoot, dependency),
        path.join(directory, dependency),
      );
    }
    const listed = Bun.spawnSync(
      ["git", "ls-tree", "-r", "--name-only", base, ".oxlint-plugins"],
      { cwd: repoRoot, stderr: "pipe" },
    );
    if (!listed.success) {
      return panic("Cannot list base plugins");
    }
    const rules: string[] = [];
    for (const file of listed.stdout
      .toString()
      .split("\n")
      .filter((candidate) =>
        /^\.oxlint-plugins\/[^/]+\.ts$/u.test(candidate),
      )) {
      const module = await import(path.join(directory, file));
      if (module.default !== undefined) {
        rules.push(...exportedRuleIds(module.default));
      }
    }
    return rules;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const main = async (): Promise<number> => {
  const directory = mkdtempSync(path.join(tmpdir(), "oxlint-rule-coverage-"));
  const coveragePath = path.join(directory, "coverage.jsonl");
  try {
    const tests = Bun.spawnSync(
      [process.execPath, "test", "./.oxlint-plugins/__tests__"],
      {
        cwd: repoRoot,
        env: { ...process.env, OXLINT_RULE_COVERAGE_PATH: coveragePath },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if (!tests.success) {
      return 1;
    }
    const problems = coverageProblems({
      ...(await repositoryRules()),
      lintConfig: config,
      trackedFiles: trackedRepoFiles(),
      coverage: readCoverage(readFileSync(coveragePath, "utf-8")),
    });
    const baseline = parseCoverageBaseline(
      readFileSync(
        path.join(repoRoot, BASELINE_PATHS.oxlintRuleCoverage),
        "utf-8",
      ),
    );
    const errors = baselineErrors(problems, baseline);
    const base = process.env["BASE_SHA"] || "origin/main";
    const resolved = Bun.spawnSync(
      ["git", "rev-parse", "--verify", `${base}^{commit}`],
      { cwd: repoRoot, stderr: "pipe" },
    );
    if (!resolved.success) {
      return panic(`Cannot resolve rule coverage comparison base: ${base}`);
    }
    const baseCommit = resolved.stdout.toString().trim();
    const parentBaseline = Bun.spawnSync(
      [
        "git",
        "cat-file",
        "-e",
        `${baseCommit}:${BASELINE_PATHS.oxlintRuleCoverage}`,
      ],
      { cwd: repoRoot, stderr: "pipe" },
    );
    if (!parentBaseline.success) {
      errors.push(
        ...initialBaselineErrors(baseline, await readBaseRules(baseCommit)),
      );
    }
    const membership = runLedgerMembershipGuard({
      ledgerRel: BASELINE_PATHS.oxlintRuleCoverage,
      repoRoot,
      parseLedger: (text) => Object.keys(parseCoverageBaseline(text)),
      label: "custom rule coverage",
      remediation: "wire the rule and add reporting and clean test cases",
      args: ["--base", baseCommit],
    });
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0 || membership !== 0) {
      return 1;
    }
    console.log(
      `Custom rule coverage OK (${problems.length} baseline entries).`,
    );
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
