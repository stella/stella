// Assert how many times each local rule fires on each fixture line.
//
// The fixture lint in `lint-oxlint-fixtures.sh` proves every suppression is
// used, but a suppression covers every hit of its rule on the line, so a line
// written to exercise two forms passes when only one of them fires. This check
// lints an unsuppressed copy of the fixtures and compares hit counts. A
// next-line suppression of a local rule expects exactly one hit of that rule on
// the following line, a same-line suppression one hit on its own line, and a
// rationale of `-- xN` (e.g. `-- x2: both forms`) expects N. A comment
// `expect-clean: <rule>` marks the next line as a case the rule must accept.
//
// Both the `oxlint-` and `eslint-` spellings count. Any other local-rule hit
// in a fixture is a failure. An `expect-clean` marker must precede code (the
// registry check requires one per rule). Only rules from `.oxlint-plugins` are
// counted; suppressions of built-in rules, and block `oxlint-disable`
// comments that deliberately silence a rule for a whole fixture, stay in place.
//
// The copy keeps repository-relative paths (path-scoped overrides and rules
// that read the tree resolve the same way): a temporary root mirrors the
// repository through symlinks, except for the fixture directory, which holds
// the rewritten fixtures.

import { panic } from "better-result";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PLUGIN_DIRECTORY = ".oxlint-plugins";
const FIXTURE_DIRECTORY = path.join(PLUGIN_DIRECTORY, "__fixtures__");

// Rules that read suppression comments themselves: rewriting the directives
// changes what they see, so the directive-usage pass alone covers them.
const DIRECTIVE_READING_PLUGINS = new Set(["suppression-hygiene"]);

const localPluginNames = new Set(
  readdirSync(path.join(REPO_ROOT, PLUGIN_DIRECTORY))
    .filter((file) => file.endsWith(".ts") && file !== "utils.ts")
    .map((file) => path.basename(file, ".ts")),
);

const isCountedRule = (ruleId: string): boolean => {
  const pluginName = ruleId.split("/").at(0) ?? "";
  return (
    localPluginNames.has(pluginName) &&
    !DIRECTIVE_READING_PLUGINS.has(pluginName)
  );
};

const DIRECTIVE_PATTERN =
  /(?<prefix>\/\/|\/\*|\{\/\*)\s*(?<kind>(?:oxlint|eslint)-disable-(?:next-)?line)\s(?<rest>.*)$/u;
const BLOCK_END_PATTERN = /\*\/\}?$/u;
const COUNT_PATTERN = /(?:^|\s)x(?<count>\d+)(?:\s|:|$)/u;
const CLEAN_MARKER_PATTERN = /^\s*(?:\/\/|\{?\/\*)\s*expect-clean:/u;
const NON_CODE_LINE_PATTERN = /^\s*(?:$|\/\/|\/\*|\*|\{\/\*)/u;

type Expectation = { file: string; line: number; ruleId: string };

const expectationKey = ({ file, line, ruleId }: Expectation): string =>
  `${file}:${line}:${ruleId}`;

type RewriteResult = {
  source: string;
  expected: Map<string, number>;
  problems: string[];
};

// Remove counted rules from each directive, recording what the directive
// promised. Line count is preserved so reported lines match the original.
export const rewriteFixture = (file: string, source: string): RewriteResult => {
  const expected = new Map<string, number>();
  const problems: string[] = [];
  const lines = source.split("\n");
  const rewritten = lines.map((text, index) => {
    if (
      CLEAN_MARKER_PATTERN.test(text) &&
      NON_CODE_LINE_PATTERN.test(lines[index + 1] ?? "")
    ) {
      problems.push(`${file}:${index + 1}: expect-clean must precede code`);
    }
    const commentStart = text.search(/\/\/|\/\*|\{\/\*/u);
    if (commentStart === -1) {
      return text;
    }
    const match = DIRECTIVE_PATTERN.exec(text.slice(commentStart));
    if (match?.groups === undefined) {
      return text;
    }
    const { prefix, kind, rest } = match.groups;
    if (prefix === undefined || kind === undefined || rest === undefined) {
      return text;
    }
    const trimmed = rest.trimEnd();
    const suffix = BLOCK_END_PATTERN.exec(trimmed)?.[0];
    const body = (
      suffix === undefined ? trimmed : trimmed.slice(0, -suffix.length)
    ).trim();
    const rationaleStart = body.indexOf(" --");
    const ruleList =
      rationaleStart === -1 ? body : body.slice(0, rationaleStart);
    const rationale =
      rationaleStart === -1 ? "" : body.slice(rationaleStart + 3).trim();
    const rules = ruleList
      .split(",")
      .map((rule) => rule.trim())
      .filter(Boolean);
    const counted = rules.filter(isCountedRule);
    if (counted.length === 0) {
      return text;
    }
    const count = Number(COUNT_PATTERN.exec(rationale)?.groups?.["count"] ?? 1);
    // 1-based line of the code the directive covers.
    const targetLine = kind.endsWith("-disable-line") ? index + 1 : index + 2;
    for (const ruleId of counted) {
      const key = expectationKey({ file, line: targetLine, ruleId });
      expected.set(key, (expected.get(key) ?? 0) + count);
    }
    const kept = rules.filter((rule) => !isCountedRule(rule));
    const replacement =
      kept.length === 0
        ? `${prefix} fixture-expect ${counted.join(", ")}`
        : `${prefix} ${kind} ${kept.join(", ")}${rationale === "" ? "" : ` -- ${rationale}`}`;
    return `${text.slice(0, commentStart)}${replacement}${suffix === undefined ? "" : ` ${suffix}`}`;
  });
  return { source: rewritten.join("\n"), expected, problems };
};

type Expectations = { expected: Map<string, number>; problems: string[] };

const copyFixtures = (
  sourceDirectory: string,
  targetDirectory: string,
  expectations: Expectations,
): void => {
  mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory)) {
    const sourcePath = path.join(sourceDirectory, entry);
    const targetPath = path.join(targetDirectory, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyFixtures(sourcePath, targetPath, expectations);
      continue;
    }
    const relativePath = path.relative(REPO_ROOT, sourcePath);
    const result = rewriteFixture(
      relativePath,
      readFileSync(sourcePath, "utf-8"),
    );
    for (const [key, count] of result.expected) {
      expectations.expected.set(key, count);
    }
    expectations.problems.push(...result.problems);
    writeFileSync(targetPath, result.source);
  }
};

const buildMirror = (expectations: Expectations): string => {
  const mirror = mkdtempSync(path.join(tmpdir(), "oxlint-fixture-counts-"));
  for (const entry of readdirSync(REPO_ROOT)) {
    if (entry === PLUGIN_DIRECTORY || entry === ".git") {
      continue;
    }
    symlinkSync(path.join(REPO_ROOT, entry), path.join(mirror, entry));
  }
  const pluginMirror = path.join(mirror, PLUGIN_DIRECTORY);
  mkdirSync(pluginMirror);
  for (const entry of readdirSync(path.join(REPO_ROOT, PLUGIN_DIRECTORY))) {
    if (entry === "__fixtures__") {
      continue;
    }
    symlinkSync(
      path.join(REPO_ROOT, PLUGIN_DIRECTORY, entry),
      path.join(pluginMirror, entry),
    );
  }
  copyFixtures(
    path.join(REPO_ROOT, FIXTURE_DIRECTORY),
    path.join(mirror, FIXTURE_DIRECTORY),
    expectations,
  );
  return mirror;
};

type OxlintDiagnostic = {
  code?: string;
  filename?: string;
  labels?: { span?: { line?: number } }[];
};

// `plugin(rule): message` is how oxlint's JSON output names a rule.
const ruleIdFromCode = (code: string): string | null => {
  const match = /^(?<plugin>[^()]+)\((?<rule>[^()]+)\)$/u.exec(code);
  const plugin = match?.groups?.["plugin"];
  const rule = match?.groups?.["rule"];
  return plugin === undefined || rule === undefined
    ? null
    : `${plugin}/${rule}`;
};

const lintMirror = (
  mirror: string,
  targets: readonly string[],
): OxlintDiagnostic[] => {
  // A piped stdout truncates large reports; write the JSON to a file instead.
  const reportPath = path.join(mirror, "oxlint-report.json");
  const result = Bun.spawnSync(
    [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--format=json",
      ...targets,
    ],
    { cwd: mirror, stdout: Bun.file(reportPath), stderr: "pipe" },
  );
  const stdout = readFileSync(reportPath, "utf-8");
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("diagnostics" in parsed) ||
    !Array.isArray(parsed.diagnostics)
  ) {
    return panic(
      `Unexpected oxlint output:\n${stdout}\n${result.stderr.toString()}`,
    );
  }
  return parsed.diagnostics;
};

// Optional arguments narrow the check to some fixtures (repository-relative
// paths) while a rule is being developed; CI checks the whole directory.
const main = (targets: readonly string[]): number => {
  const expectations: Expectations = { expected: new Map(), problems: [] };
  const mirror = buildMirror(expectations);
  const inTargets = (key: string): boolean =>
    targets.length === 0 || targets.some((target) => key.startsWith(target));
  const expected = new Map(
    [...expectations.expected].filter(([key]) => inTargets(key)),
  );
  const actual = new Map<string, number>();
  try {
    const lintTargets = targets.length === 0 ? [FIXTURE_DIRECTORY] : targets;
    for (const diagnostic of lintMirror(mirror, lintTargets)) {
      const ruleId = ruleIdFromCode(diagnostic.code ?? "");
      const line = diagnostic.labels?.at(0)?.span?.line;
      if (ruleId === null || !isCountedRule(ruleId) || line === undefined) {
        continue;
      }
      const file = path.relative(
        mirror,
        path.resolve(mirror, diagnostic.filename ?? ""),
      );
      const key = expectationKey({ file, line, ruleId });
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }

  const failures = expectations.problems.filter(inTargets);
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(key) ?? 0;
    const got = actual.get(key) ?? 0;
    if (want !== got) {
      failures.push(`${key}: expected ${want} hit(s), got ${got}`);
    }
  }
  if (failures.length > 0) {
    console.error("Oxlint fixture hit counts differ:");
    for (const failure of failures.sort()) {
      console.error(`- ${failure}`);
    }
    console.error(
      "Annotate a directive covering several hits with `-- xN` (e.g. `-- x2`).",
    );
    return 1;
  }
  console.log(`Oxlint fixture hit counts OK (${expected.size} lines).`);
  return 0;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
