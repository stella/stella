import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_NAME = "no-font-utility-in-reader";
const RULE_ID = `${RULE_NAME}/${RULE_NAME}`;
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * The line one diagnostic of this rule reports, or null for any other
 * diagnostic. Narrowed rather than asserted: the report is another process's
 * output, so its shape is a claim to check, not one to assume.
 */
const reportedLine = (diagnostic: unknown): number | null => {
  if (!isRecord(diagnostic) || typeof diagnostic.code !== "string") {
    return null;
  }
  if (!diagnostic.code.startsWith(`${RULE_NAME}(`)) {
    return null;
  }
  const label = isUnknownArray(diagnostic.labels)
    ? diagnostic.labels.at(0)
    : undefined;
  const span = isRecord(label) ? label.span : undefined;
  const line = isRecord(span) ? span.line : undefined;
  return typeof line === "number" ? line : null;
};

/**
 * The lines this rule reported, in order.
 *
 * Read out of oxlint's JSON report rather than its rendered output: the
 * rendering varies with terminal and environment, and a test that parses it
 * reads as a rule regression when it drifts.
 */
const lint = async (source: string): Promise<number[]> => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-oxlint-reader-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [
        path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${RULE_NAME}.ts`),
      ],
      rules: { [RULE_ID]: "error" },
    })};\n`,
  );
  const sourcePath = path.join(directory, "reader-surface.tsx");
  await Bun.write(sourcePath, source);

  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "-f",
      "json",
      sourcePath,
    ],
    { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
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
    .map(reportedLine)
    .filter((line): line is number => line !== null);
};

describe.serial(RULE_NAME, () => {
  test("reports a font family wherever the class string is written", async () => {
    const source = [
      `export const _a = () => <p className="font-sans text-xs" />;`,
      `export const _b = () => <span className={cn("font-serif", extra)} />;`,
      "export const _c = () => <div className={`md:font-mono`} />;",
      `export const HEADING = { 1: "font-sans text-lg" };`,
      // The `!` modifier and stacked variants are the same utility.
      `export const _d = () => <p className="group-hover:font-sans!" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5]);
  });

  test("accepts the named classes and utilities that name no family", async () => {
    const source = [
      `export const _a = () => <p className="reader-chrome text-xs" />;`,
      `export const _b = () => <span className="reader-body text-sm" />;`,
      `export const _c = () => <h1 className="text-xl font-semibold" />;`,
      `export const _d = () => <span className={cn("font-medium", extra)} />;`,
      // A CSS variable of the same name is a value, not a utility.
      `export const _e = () => <p style={{ fontFamily: "var(--font-sans)" }} />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
