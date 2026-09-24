import { panic, Result } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
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
  /** The plugin that carries the rule, when it is not named after it. */
  plugin?: string;
  /** The rule's options object, for a rule configured by data. */
  ruleOptions?: unknown;
  /** Where the source is written, relative to a scratch root. */
  sourcePath?: string;
};

/**
 * The lines one local rule reports on `source`, in order, run through the
 * real oxlint CLI with only that rule enabled. Read from the JSON report, not
 * the rendered output, which varies with terminal and environment.
 */
export const lintSingleRule = async (
  ruleName: string,
  source: string,
  {
    plugin = ruleName,
    ruleOptions,
    sourcePath = "source.ts",
  }: LintSingleRuleOptions = {},
): Promise<number[]> => {
  const directory = await mkdtemp(path.join(tmpdir(), `stella-${ruleName}-`));
  const lintResult = await Result.tryPromise(async () => {
    const configPath = path.join(directory, "oxlint.config.ts");
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${plugin}.ts`),
        ],
        rules: {
          [`${plugin}/${ruleName}`]:
            ruleOptions === undefined ? "error" : ["error", ruleOptions],
        },
      })};\n`,
    );
    const sourceFile = path.join(directory, sourcePath);
    await Bun.write(sourceFile, source);
    const spawned = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "oxlint",
        "-c",
        configPath,
        "-f",
        "json",
        sourceFile,
      ],
      { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    return { stdout, stderr };
  });
  await rm(directory, { force: true, recursive: true });
  if (Result.isError(lintResult)) {
    return panic(`oxlint run failed: ${lintResult.error.message}`);
  }
  const { stdout, stderr } = lintResult.value;
  const output = ["stdout:", String(stdout), "stderr:", String(stderr)].join(
    "\n",
  );
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
  return diagnostics
    .map((diagnostic) =>
      reportedLine(
        diagnostic,
        plugin === ruleName ? `${plugin}(` : `${plugin}(${ruleName})`,
      ),
    )
    .filter((line): line is number => line !== null)
    .toSorted((left, right) => left - right);
};
