import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_NAME = "no-parser-validator-calls";
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
 * rendering is a presentation choice that varies with terminal and
 * environment, and a test that parses it reads as a rule regression when it
 * drifts.
 */
const lint = async (source: string): Promise<number[]> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-oxlint-parser-validator-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      jsPlugins: [
        path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${RULE_NAME}.ts`),
      ],
      rules: { [RULE_ID]: "error" },
    })};\n`,
  );
  const sourcePath = path.join(directory, "adapter.ts");
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

describe.serial("no-parser-validator-calls", () => {
  test("charges source-bearing validator re-exports, including renamed facade exports", async () => {
    expect(
      await lint(
        [
          'export { validateAndLog as check } from "./validator-facade";',
          'export { validateAst as checkAst } from "./validator-facade";',
          'export type { validateAst as ValidatorType } from "./validator-facade";',
          'export { type validateAst } from "./validator-facade";',
          "const validateAst = () => {}; export { validateAst };",
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("computed names use literal values and scoped constant string bindings", async () => {
    expect(
      await lint(
        [
          "declare const oracle: any;",
          'oracle["validateAst"]();',
          "oracle[`validateAst`]();",
          'const validatorProperty = "validateAndLog"; oracle[validatorProperty]();',
          '{ const validateAst = "differentMethod"; oracle[validateAst](); }',
          'const validateAst = "validateAndLog";',
          '{ const validateAst = "differentMethod"; oracle[validateAst](); }',
          "oracle[validateAst]();",
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 8]);
  });

  test("unknown computed oracle accesses are charged without flagging unrelated objects", async () => {
    expect(
      await lint(
        [
          'import * as oracle from "./validate-ast";',
          "declare const dynamic: string; oracle[dynamic]();",
          'let mutable = "safe"; mutable = dynamic; oracle[mutable]();',
          "const generated = getKey(); oracle[generated]();",
          'const safe = "differentMethod"; oracle[safe]();',
          // oxlint-disable-next-line no-template-curly-in-string -- fixture source preserves a runtime template expression
          "oracle[`validate${dynamic}`]();",
          "declare const unrelated: any; unrelated[dynamic]();",
          "const alias = oracle; alias[dynamic]();",
          "function local(oracle: any) { oracle[dynamic](); }",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 6, 8]);
  });
});
