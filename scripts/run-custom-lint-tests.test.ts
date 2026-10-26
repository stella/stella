import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "tsrs/unstable/async";

import { rejectionOf } from "@stll/property-testing/rejection";

import { customLintRunnerViolations } from "./check-custom-lint-test-runners";
import {
  customLintTestCommand,
  customLintTestCommands,
  runCustomLintTestCommands,
  runCustomLintTests,
} from "./run-custom-lint-tests";

test("the runner census preserves standard array join types", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runner-census-types-"));
  const filename = path.join(directory, "fixture.ts");
  try {
    writeFileSync(
      filename,
      `import ${JSON.stringify(path.join(import.meta.dir, "check-custom-lint-test-runners"))};
const fields = ["type", "display_name"] as const;
const rows = [fields.join(",")];
declare const dataRow: string;
rows.push(dataRow);
`,
    );
    const config = path.join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        files: [filename],
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "Bundler",
          types: [],
        },
      }),
    );
    const api = new API({ cwd: directory });
    try {
      const snapshot = await api.createSnapshot({ openProjects: [config] });
      const project =
        snapshot.getConfiguredProject(config) ??
        panic("The array join type fixture was not loaded");
      expect(
        (await project.program.getSemanticDiagnostics([filename])).map(
          ({ text }) => text,
        ),
      ).toEqual([]);
    } finally {
      await api.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const args of [
  [],
  ["--parallel"],
  ["-t", "case"],
  ["./.oxlint-plugins/__tests__/fixture.test.ts"],
]) {
  test(`the runner retains its budget for ${JSON.stringify(args)}`, () => {
    const command = customLintTestCommand(args);
    expect(command.slice(0, 4)).toEqual([
      process.execPath,
      "test",
      "--timeout",
      "30000",
    ]);
    expect(command.slice(4)).toEqual(
      args.some((arg) => arg.endsWith(".test.ts"))
        ? args
        : [...args, "./.oxlint-plugins/__tests__"],
    );
  });
}

test("caller flags cannot replace the shared budget", () => {
  for (const args of [["--timeout", "5000"], ["--timeout=5000"]]) {
    expect(() => customLintTestCommand(args)).toThrow(
      "owned by the shared runner",
    );
  }
});

test("full-suite batches cover every discovered file exactly once within two workers", () => {
  for (const count of [1, 2, 3, 17]) {
    const paths = Array.from(
      { length: count },
      (_, index) => `./fixtures/${index}.test.ts`,
    );
    for (const args of [[], ["--parallel"]]) {
      const commands = customLintTestCommands(args, paths);
      expect(commands.length).toBeLessThanOrEqual(2);
      expect(
        commands.flatMap((command) => command.slice(4)).toSorted(),
      ).toEqual(paths.toSorted());
      for (const command of commands) {
        expect(command).not.toContain("--parallel");
        expect(command.slice(0, 4)).toEqual(
          customLintTestCommand(paths).slice(0, 4),
        );
      }
    }
  }
  expect(() => customLintTestCommands([], [])).toThrow("found no test files");
});

test("selectors and output flags retain their single-command semantics", () => {
  for (const args of [
    ["-t", "case"],
    ["--coverage"],
    ["--reporter-outfile", "output.xml"],
    ["--shard", "1/2"],
    ["./fixture.test.ts"],
    ["--parallel", "./fixture.test.ts"],
  ]) {
    const commands = customLintTestCommands(args, []);
    expect(commands).toEqual([
      customLintTestCommand(
        args.filter((argument) => argument !== "--parallel"),
      ),
    ]);
    expect(commands.flat()).not.toContain("--parallel");
  }
  for (const args of [
    ["-t", "--parallel"],
    ["--", "--parallel"],
  ]) {
    expect(customLintTestCommands(args, [])).toEqual([
      customLintTestCommand(args),
    ]);
  }
});

test("a failed worker leaves the other worker running and fails the result", async () => {
  const commands = customLintTestCommands(
    [],
    ["./first.test.ts", "./second.test.ts"],
  );
  const visited: number[] = [];
  let finishSecond = (_status: number) => {};
  const second = new Promise<number>((resolve) => {
    finishSecond = resolve;
  });
  const pending = runCustomLintTestCommands(
    commands,
    async (_command, worker) => {
      visited.push(worker);
      return worker === 0 ? 1 : second;
    },
  );
  expect(visited).toEqual([0, 1]);
  finishSecond(0);
  expect(await pending).toBe(1);
  expect(await runCustomLintTestCommands(commands, async () => 0)).toBe(0);
  expect(
    await rejectionOf(
      runCustomLintTestCommands(
        [...commands, commands[0] ?? []],
        async () => 0,
      ),
    ),
  ).toMatchObject({ message: expect.stringContaining("worker budget") });
});

test("parallel batches retain a deliberately failing fixture and every passing fixture", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "custom-lint-equivalence-"),
  );
  try {
    const paths = ["first", "second", "violating"].map((name) => {
      const filename = path.join(directory, `${name}.test.ts`);
      writeFileSync(
        filename,
        `import { test, expect } from "bun:test"; test("${name}", () => { expect(${name === "violating"}).toBe(false); });`,
      );
      return filename;
    });
    const old = Bun.spawnSync(customLintTestCommand(paths));
    const output: string[] = [];
    const status = await runCustomLintTestCommands(
      customLintTestCommands([], paths),
      async (command) => {
        const child = Bun.spawn([...command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = new Response(child.stderr).text();
        const exitCode = await child.exited;
        output.push(await stderr);
        return exitCode;
      },
    );
    expect(old.exitCode).toBe(1);
    expect(status).toBe(old.exitCode);
    for (const name of ["first", "second", "violating"]) {
      expect(old.stderr.toString()).toContain(name);
      expect(output.join("\n")).toContain(name);
    }
    expect(output.join("\n")).toContain("(fail) violating");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Fixtures that fail on purpose run without GITHUB_ACTIONS, so bun test
// writes no ::error annotation into the job that runs this file.
const withoutCiAnnotations = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "GITHUB_ACTIONS"),
  );

test("the workers receive exactly the environment the caller passes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "custom-lint-env-"));
  try {
    const seen = path.join(directory, "seen.json");
    const filename = path.join(directory, "env.test.ts");
    writeFileSync(
      filename,
      `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("env", () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ actions: process.env["GITHUB_ACTIONS"] ?? null, marker: process.env["OXLINT_RULE_COVERAGE_PATH"] ?? null }));
});`,
    );
    expect(
      await runCustomLintTests(
        customLintTestCommands([], [filename]),
        undefined,
        {
          ...withoutCiAnnotations(),
          // Without a coverage path the runner leaves this one as the caller set it.
          OXLINT_RULE_COVERAGE_PATH: "caller-value",
        },
      ),
    ).toBe(0);
    expect(JSON.parse(readFileSync(seen, "utf-8"))).toEqual({
      actions: null,
      marker: "caller-value",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker coverage merges complete records and preserves prior caller coverage", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "custom-lint-coverage-"));
  try {
    const coveragePath = path.join(directory, "coverage.jsonl");
    writeFileSync(
      coveragePath,
      `${JSON.stringify({ ruleId: "prior", outcome: "clean" })}\n`,
    );
    const paths = ["clean", "report"].map((outcome) => {
      const filename = path.join(directory, `${outcome}.test.ts`);
      writeFileSync(
        filename,
        `import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
test("${outcome}", () => {
  for (let index = 0; index < 50; index += 1) appendFileSync(process.env["OXLINT_RULE_COVERAGE_PATH"], JSON.stringify({ ruleId: "fixture/" + index, outcome: "${outcome}" }) + "\\n");
  expect(true).toBe(${outcome === "clean"});
});`,
      );
      return filename;
    });
    // The report fixture fails on purpose: it must not annotate the CI run.
    expect(
      await runCustomLintTests(
        customLintTestCommands([], paths),
        coveragePath,
        withoutCiAnnotations(),
      ),
    ).toBe(1);
    const records = readFileSync(coveragePath, "utf-8").trim().split("\n");
    expect(records.length).toBe(101);
    expect(JSON.parse(records[0] ?? "")).toEqual({
      ruleId: "prior",
      outcome: "clean",
    });
    for (const index of Array.from({ length: 50 }, (_, position) => position)) {
      for (const outcome of ["clean", "report"]) {
        expect(records).toContain(
          JSON.stringify({ ruleId: `fixture/${index}`, outcome }),
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const TARGET = "./.oxlint-plugins/__tests__/fixture.test.ts";
for (const [filename, source] of [
  ["package.json", JSON.stringify({ scripts: { test: `bun test ${TARGET}` } })],
  ["scripts/check.sh", `bun test --parallel ${TARGET}`],
  [
    "scripts/check.sh",
    `find .oxlint-plugins/__tests__ -name '*.test.ts' | xargs bun test`,
  ],
  ["scripts/check.sh", `bun --bun test .oxlint-plugins/__tests__/*.test.ts`],
  ["ci.yml", `jobs:\n  check:\n    steps:\n      - run: bun test ${TARGET}`],
  [
    "scripts/check.ts",
    `Bun.spawnSync([process.execPath, "test", "${TARGET}"]);`,
  ],
  [
    "scripts/check.ts",
    `const args = ["test", "${TARGET}"]; execFileSync("bun", args);`,
  ],
  [
    "scripts/check.ts",
    `const target = "${TARGET}"; Bun.spawnSync([process.execPath, "test", target]);`,
  ],
  [
    "scripts/check.ts",
    `Bun.spawn({ cmd: [process.execPath, "test", "${TARGET}"] });`,
  ],
] as const) {
  test(`${filename} rejects a planted runner bypass`, () => {
    expect(customLintRunnerViolations(filename, source)).toEqual([
      `${filename}: run custom lint tests through scripts/run-custom-lint-tests.ts`,
    ]);
  });
}

test("shared commands and inert text are accepted", () => {
  expect(
    customLintRunnerViolations(
      "scripts/check.sh",
      `bun scripts/run-custom-lint-tests.ts ${TARGET}`,
    ),
  ).toEqual([]);
  expect(
    customLintRunnerViolations("scripts/check.sh", `# bun test ${TARGET}`),
  ).toEqual([]);
  expect(
    customLintRunnerViolations(
      "scripts/check.ts",
      `const text = 'bun test ${TARGET}';`,
    ),
  ).toEqual([]);
});

// Measured p95 is 20.2 s; both spawned files must outlive Bun's default timeout.
test("the CLI budget reaches every sequential file and its removal fails", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "custom-lint-budget-"));
  try {
    const files = ["first", "second"].map((name) => {
      const filename = path.join(directory, `${name}.test.ts`);
      writeFileSync(
        filename,
        `import { test, expect } from "bun:test"; test("${name}", async () => { await Bun.sleep(5100); expect(true).toBe(true); });`,
      );
      return filename;
    });
    const command = customLintTestCommand(files);
    const passing = Bun.spawnSync(command);
    expect(passing.exitCode).toBe(0);
    expect(passing.stderr.toString()).toContain("2 pass");
    const mutation = Bun.spawnSync([process.execPath, "test", ...files]);
    expect(mutation.exitCode).toBe(1);
    expect(mutation.stderr.toString()).toContain("timed out after 5000ms");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
