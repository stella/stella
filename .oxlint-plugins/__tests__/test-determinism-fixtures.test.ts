import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isRecord } from "../../scripts/oxlint-config-scopes.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const RULES = [
  "no-ambient-time-in-tests",
  "no-real-timers-in-tests",
  "no-wallclock-assertions-in-tests",
] as const;

const fixtureSources = () =>
  Object.fromEntries(
    RULES.map((rule) => {
      const filename = `${rule}.fixture.test.ts`;
      return [
        filename,
        readFileSync(
          path.join(REPOSITORY_ROOT, ".oxlint-plugins/__fixtures__", filename),
          "utf-8",
        ),
      ];
    }),
  );

const lintFixtures = async (sources: Readonly<Record<string, string>>) => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "stella-test-determinism-fixtures-")),
  );
  const result = await Result.tryPromise(async () => {
    const configPath = path.join(directory, "oxlint.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: RULES.map((rule) =>
          path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${rule}.ts`),
        ),
        rules: Object.fromEntries(
          RULES.map((rule) => [`${rule}/${rule}`, "error"]),
        ),
      }),
    );
    for (const [filename, source] of Object.entries(sources)) {
      await Bun.write(path.join(directory, filename), source);
    }
    const spawned = Bun.spawn(
      [
        process.execPath,
        "--bun",
        path.join(REPOSITORY_ROOT, "node_modules/.bin/oxlint"),
        "-c",
        configPath,
        "--threads=1",
        "--disable-nested-config",
        "--report-unused-disable-directives-severity=error",
        "-f",
        "json",
        ...Object.keys(sources),
      ],
      { cwd: directory, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    const parsed = Result.try((): unknown => JSON.parse(stdout));
    if (
      Result.isError(parsed) ||
      !isRecord(parsed.value) ||
      !Array.isArray(parsed.value.diagnostics) ||
      parsed.value.number_of_files !== Object.keys(sources).length ||
      parsed.value.number_of_rules !== RULES.length ||
      (exitCode !== 0 && exitCode !== 1)
    ) {
      return panic(
        `oxlint must execute every fixture and rule:\n${stdout}\n${stderr}`,
      );
    }
    const diagnostics: unknown[] = parsed.value.diagnostics;
    const codes = diagnostics.map((diagnostic) => {
      if (!isRecord(diagnostic) || typeof diagnostic.code !== "string") {
        return panic(
          `oxlint reported a parser or configuration error:\n${stdout}\n${stderr}`,
        );
      }
      return diagnostic.code;
    });
    return { codes, exitCode };
  });
  await rm(directory, { force: true, recursive: true });
  if (Result.isError(result)) {
    return panic(`oxlint fixture run failed: ${result.error.message}`);
  }
  return result.value;
};

test("time-rule fixtures stay clean with every time rule enabled", async () => {
  expect(await lintFixtures(fixtureSources())).toEqual({
    codes: [],
    exitCode: 0,
  });
});

test("combined fixture check catches unsuppressed ambient inputs in the wallclock specimen", async () => {
  const sources = fixtureSources();
  const wallclockFilename = "no-wallclock-assertions-in-tests.fixture.test.ts";
  const wallclock = sources[wallclockFilename];
  if (wallclock === undefined) {
    panic("Wallclock fixture is missing from the combined check");
  }
  sources[wallclockFilename] = wallclock.replaceAll(
    /^\/\/ oxlint-disable-next-line no-ambient-time-in-tests\/no-ambient-time-in-tests[^\n]*\n/gmu,
    "",
  );
  expect(sources[wallclockFilename]).not.toBe(wallclock);
  expect(await lintFixtures(sources)).toEqual({
    codes: [
      "no-ambient-time-in-tests(no-ambient-time-in-tests)",
      "no-ambient-time-in-tests(no-ambient-time-in-tests)",
    ],
    exitCode: 1,
  });
});
