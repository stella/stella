import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_NAME = "no-layout-motion-classes";
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
type LintOptions = {
  allowedFiles?: readonly { path: string; reason: string }[];
  fileName?: string;
};

const lint = async (
  source: string,
  { allowedFiles, fileName = "motion-surface.tsx" }: LintOptions = {},
): Promise<number[]> => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-oxlint-motion-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [
        path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${RULE_NAME}.ts`),
      ],
      rules: {
        [RULE_ID]:
          allowedFiles === undefined ? "error" : ["error", { allowedFiles }],
      },
    })};\n`,
  );
  const sourcePath = path.join(directory, fileName);
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
  test("reports motion and viewport utilities wherever the class string is written", async () => {
    const source = [
      `export const _a = () => <p className="transition-all duration-150" />;`,
      `export const _b = () => <span className={cn("min-h-screen", extra)} />;`,
      "export const _c = () => <div className={`md:transition-[height]`} />;",
      `export const PANEL = { wide: "w-screen max-h-screen" };`,
      `export const _d = () => <p className="animate-[margin-inline_200ms]" />;`,
      // The `!` modifier and stacked variants are the same utility.
      `export const _e = () => <p className="group-hover:transition-all!" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("exempts a listed box-owning surface, and only that file", async () => {
    const source = [
      `export const _a = () => <div className="w-(--rail) transition-[width]" />;`,
      "",
    ].join("\n");
    const allowedFiles = [
      {
        path: "collapsible-rail.tsx",
        reason: "Collapsible rail animates the width it owns.",
      },
    ] as const;

    expect(
      await lint(source, { allowedFiles, fileName: "collapsible-rail.tsx" }),
    ).toEqual([]);
    expect(
      await lint(source, { allowedFiles, fileName: "ordinary-card.tsx" }),
    ).toEqual([1]);
  });

  test("keeps transition-all and the viewport units reported in an allowed file", async () => {
    const source = [
      `export const _a = () => <div className="transition-[width] transition-all" />;`,
      `export const _b = () => <div className="transition-[height] min-h-screen" />;`,
      "",
    ].join("\n");

    expect(
      await lint(source, {
        allowedFiles: [
          {
            path: "collapsible-rail.tsx",
            reason: "Collapsible rail animates the width it owns.",
          },
        ],
        fileName: "collapsible-rail.tsx",
      }),
    ).toEqual([1, 2]);
  });

  test("accepts compositable motion and dynamic-viewport utilities", async () => {
    const source = [
      `export const _a = () => <p className="transition-opacity duration-150" />;`,
      `export const _b = () => <span className="transition-transform" />;`,
      `export const _c = () => <div className="transition transition-colors" />;`,
      `export const _d = () => <section className={cn("min-h-dvh", extra)} />;`,
      `export const _e = () => <p className="h-dvh max-h-dvh w-dvw" />;`,
      `export const _f = () => <p className="animate-[pulse_700ms_ease-in-out_3]" />;`,
      // A rounded corner names a physical side, not an animated layout property.
      `export const _g = () => <p className="animate-in rounded-tl-md" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
