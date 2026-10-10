import { panic, Result } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

/** The oxlint JSON report fields this helper reads, at any nesting level. */
type OxlintJsonNode = {
  readonly code?: unknown;
  readonly labels?: unknown;
  readonly span?: unknown;
  readonly line?: unknown;
  readonly diagnostics?: unknown;
  readonly number_of_files?: unknown;
  readonly number_of_rules?: unknown;
  readonly filename?: unknown;
};

const isRecord = (value: unknown): value is OxlintJsonNode =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/** The line one diagnostic with `code` reports, or null for any other. */
const reportedLine = (diagnostic: unknown, code: string): number | null => {
  if (!isRecord(diagnostic) || typeof diagnostic.code !== "string") {
    return null;
  }
  if (!diagnostic.code.startsWith(code)) {
    return null;
  }
  const label = isUnknownArray(diagnostic.labels)
    ? diagnostic.labels.at(0)
    : undefined;
  const span = isRecord(label) ? label.span : undefined;
  const line = isRecord(span) ? span.line : undefined;
  return typeof line === "number" ? line : null;
};

type LintSingleRuleOptions = {
  /** Use an oxlint built-in plugin instead of a local JavaScript plugin. */
  builtin?: boolean;
  /** The plugin that carries the rule, when it is not named after it. */
  plugin?: string;
  settings?: Record<string, unknown>;
  fix?: boolean;
  /** The rule's options object, for a rule configured by data. */
  ruleOptions?: unknown;
  /** Options that name paths under the scratch root the source is written to. */
  ruleOptionsForRoot?: (root: string) => unknown;
  /** Where the source is written, relative to a scratch root. */
  sourcePath?: string;
  /** Resolve source paths relative to the scratch checkout. */
  cwd?: "repository" | "scratch";
};

/**
 * The lines one rule reports on `source`, in order, run through the
 * real oxlint CLI with only that rule enabled. Read from the JSON report, not
 * the rendered output, which varies with terminal and environment.
 */
export const runSingleRule = async (
  ruleName: string,
  source: string,
  {
    builtin = false,
    plugin = ruleName,
    settings,
    fix = false,
    ruleOptions,
    ruleOptionsForRoot,
    sourcePath = "source.ts",
    cwd = "repository",
  }: LintSingleRuleOptions = {},
) => {
  const directory = await mkdtemp(path.join(tmpdir(), `stella-${ruleName}-`));
  const options = ruleOptionsForRoot?.(directory) ?? ruleOptions;
  const lintResult = await Result.tryPromise(async () => {
    const configPath = path.join(directory, "oxlint.config.ts");
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        settings,
        ...(builtin
          ? { plugins: [plugin] }
          : {
              jsPlugins: [
                path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${plugin}.ts`),
              ],
            }),
        rules: {
          [`${plugin}/${ruleName}`]:
            options === undefined ? "error" : ["error", options],
        },
      })};\n`,
    );
    const sourceFile = path.join(directory, sourcePath);
    await Bun.write(sourceFile, source);
    const spawned = Bun.spawn(
      [
        process.execPath,
        "--bun",
        path.join(REPOSITORY_ROOT, "node_modules/.bin/oxlint"),
        "-c",
        configPath,
        "-f",
        "json",
        ...(fix ? ["--fix"] : []),
        cwd === "scratch" ? sourcePath : sourceFile,
      ],
      {
        cwd: cwd === "scratch" ? directory : REPOSITORY_ROOT,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    return {
      stdout,
      stderr,
      exitCode,
      source: readFileSync(sourceFile, "utf-8"),
    };
  });
  await rm(directory, { force: true, recursive: true });
  if (Result.isError(lintResult)) {
    return panic(`oxlint run failed: ${lintResult.error.message}`);
  }
  const { stdout, stderr, exitCode } = lintResult.value;
  const output = ["stdout:", stdout, "stderr:", stderr].join("\n");
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isError(report)) {
    return panic(`oxlint did not produce valid JSON:\n${output}`);
  }
  const diagnostics = isRecord(report.value)
    ? report.value.diagnostics
    : undefined;
  if (!isUnknownArray(diagnostics)) {
    return panic(`oxlint reported no diagnostics array:\n${output}`);
  }
  if (
    !isRecord(report.value) ||
    report.value.number_of_files !== 1 ||
    report.value.number_of_rules !== 1
  ) {
    return panic(
      `oxlint must execute exactly one file and one rule:\n${output}`,
    );
  }
  if (exitCode !== 0 && exitCode !== 1) {
    return panic(`oxlint failed with exit ${exitCode}:\n${output}`);
  }
  if (
    diagnostics.some(
      (diagnostic) => isRecord(diagnostic) && diagnostic.code === undefined,
    )
  ) {
    return panic(`oxlint reported a parser or configuration error:\n${output}`);
  }
  const lines = diagnostics
    .map((diagnostic) => reportedLine(diagnostic, `${plugin}(${ruleName})`))
    .filter((line): line is number => line !== null)
    .toSorted((left, right) => left - right);
  if (lines.length !== diagnostics.length) {
    return panic(
      `oxlint reported diagnostics outside the requested rule:\n${output}`,
    );
  }
  if (exitCode === 1 && lines.length === 0) {
    return panic(
      `oxlint failed without reporting the requested rule:\n${output}`,
    );
  }
  const { OXLINT_RULE_COVERAGE_PATH: coveragePath } = process.env;
  if (coveragePath !== undefined) {
    appendFileSync(
      coveragePath,
      `${JSON.stringify({ ruleId: `${plugin}/${ruleName}`, outcome: lines.length === 0 ? "clean" : "report" })}\n`,
    );
  }
  return { lines, source: lintResult.value.source };
};

export const lintSingleRule = async (
  ruleName: string,
  source: string,
  options: LintSingleRuleOptions = {},
): Promise<number[]> => (await runSingleRule(ruleName, source, options)).lines;

/**
 * The lines one rule reports in each of several files linted by ONE oxlint
 * run, keyed by file name. Proves per-file state: `createOnce` closures
 * outlive a file, so a rule that forgets to reset leaks into the next one.
 */
export const lintRuleAcrossFiles = async (
  ruleName: string,
  files: Readonly<Record<string, string>>,
  { plugin = ruleName }: { plugin?: string } = {},
): Promise<Record<string, number[]>> => {
  const directory = await mkdtemp(path.join(tmpdir(), `stella-${ruleName}-`));
  const names = Object.keys(files).toSorted();
  const lintResult = await Result.tryPromise(async () => {
    const configPath = path.join(directory, "oxlint.config.ts");
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${plugin}.ts`),
        ],
        rules: { [`${plugin}/${ruleName}`]: "error" },
      })};\n`,
    );
    for (const name of names) {
      await Bun.write(path.join(directory, name), files[name] ?? "");
    }
    const spawned = Bun.spawn(
      [
        process.execPath,
        "--bun",
        path.join(REPOSITORY_ROOT, "node_modules/.bin/oxlint"),
        "-c",
        configPath,
        "-f",
        "json",
        // One worker walks every file, so state a rule keeps between files
        // is visible instead of split across threads.
        "--threads=1",
        ...names,
      ],
      { cwd: directory, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(spawned.stdout).text(),
      spawned.exited,
    ]);
    return { stdout, exitCode };
  });
  await rm(directory, { force: true, recursive: true });
  if (Result.isError(lintResult)) {
    return panic(`oxlint run failed: ${lintResult.error.message}`);
  }
  const { stdout, exitCode } = lintResult.value;
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (
    Result.isError(report) ||
    !isRecord(report.value) ||
    !isUnknownArray(report.value.diagnostics) ||
    report.value.number_of_files !== names.length ||
    (exitCode !== 0 && exitCode !== 1)
  ) {
    return panic(`oxlint must lint every file once:\n${stdout}`);
  }
  const linesByFile: Record<string, number[]> = Object.fromEntries(
    names.map((name) => [name, []]),
  );
  for (const diagnostic of report.value.diagnostics) {
    const line = reportedLine(diagnostic, `${plugin}(${ruleName})`);
    const filename =
      isRecord(diagnostic) && typeof diagnostic.filename === "string"
        ? path.basename(diagnostic.filename)
        : undefined;
    const lines = filename === undefined ? undefined : linesByFile[filename];
    if (line === null || lines === undefined) {
      return panic(`oxlint reported an unexpected diagnostic:\n${stdout}`);
    }
    lines.push(line);
  }
  return linesByFile;
};
