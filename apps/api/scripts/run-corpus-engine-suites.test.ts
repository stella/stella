import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  assertCorpusEngineTestCoverage,
  CORPUS_ENGINE_GATE,
  CORPUS_ENGINE_REPORT_CHECK,
  CORPUS_ENGINE_TEST_FILES,
  executeCorpusSuite,
  planCorpusEngineSuites,
  runCorpusEngineSuites,
} from "./run-corpus-engine-suites";

const apiRoot = path.resolve(import.meta.dir, "..");
const suites = () =>
  planCorpusEngineSuites({
    outputRoot: "/tmp/corpus-runner-test",
    runId: "unit",
  });

type SuiteCommand = Parameters<
  NonNullable<Parameters<typeof executeCorpusSuite>[0]["run"]>
>[0];

test("suite execution mounts isolated data and passes isolated endpoint and temporary storage", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "corpus-lifecycle-"));
  const commands: SuiteCommand[] = [];
  try {
    const planned = planCorpusEngineSuites({
      outputRoot: fixture,
      runId: "lifecycle",
    }).slice(0, 2);
    for (const suite of planned) {
      const result = await executeCorpusSuite({
        apiRoot,
        image: "engine-image",
        signal: new AbortController().signal,
        suite,
        run: async (options) => {
          commands.push(options);
          return options.command.at(1) === "port" ? "127.0.0.1:12345" : "";
        },
      });
      expect(result.exitCode).toBe(0);
      expect(
        commands.some(
          ({ command }) =>
            command.includes(suite.containerName) &&
            command.includes(
              `type=bind,source=${suite.dataDir},target=/quickwit/qwdata`,
            ),
        ),
      ).toBe(true);
      const child = commands.find(({ command }) =>
        command.includes(suite.file),
      );
      expect(child?.environment?.["STELLA_CORPUS_ENGINE_TEST_ENDPOINT"]).toBe(
        "http://127.0.0.1:12345",
      );
      expect(child?.environment?.["TMPDIR"]).toBe(
        path.join(suite.outputDir, "tmp"),
      );
      expect(child?.environment?.["STELLA_RUN_POSTGRES_TESTS"]).toBeUndefined();
      expect(child?.environment?.["PGLITE_TEST_SNAPSHOT"]).toBeUndefined();
      expect(child?.command).toContain(`--reporter-outfile=${suite.junitPath}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test.each(["test", "readiness", "cleanup"] as const)(
  "%s failure remains visible while teardown runs outside cancellation",
  async (failure) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "corpus-lifecycle-"));
    const abort = new AbortController();
    const commands: SuiteCommand[] = [];
    try {
      const suite = planCorpusEngineSuites({
        outputRoot: fixture,
        runId: "failure",
      }).at(0);
      if (suite === undefined) {
        throw new TypeError("fixture suite is missing");
      }
      const error = await rejectionOf(
        executeCorpusSuite({
          apiRoot,
          image: "engine-image",
          signal: abort.signal,
          suite,
          run: async (options) => {
            commands.push(options);
            const failingCommand = {
              test: options.command.includes(suite.file),
              readiness: options.command.at(0) === "curl",
              cleanup: options.command.at(1) === "rm",
            };
            const fails = failingCommand[failure];
            if (fails) {
              abort.abort();
              throw new TypeError(`${failure} fixture failure`);
            }
            return options.command.at(1) === "port" ? "127.0.0.1:12345" : "";
          },
        }),
      );
      expect(error).toMatchObject({
        message: expect.stringContaining(`${failure} fixture failure`),
      });
      expect(abort.signal.aborted).toBe(true);
      for (const operation of ["logs", "rm"]) {
        const cleanup = commands.find(
          ({ command }) => command.at(1) === operation,
        );
        expect(cleanup?.command).toContain(suite.containerName);
        expect(cleanup?.signal).toBeUndefined();
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

test("successful suites return zero and report every file's elapsed time", async () => {
  const messages: string[] = [];
  const result = await runCorpusEngineSuites({
    suites: suites(),
    execute: async () => ({ exitCode: 0 }),
    signal: new AbortController().signal,
    report: (message) => {
      messages.push(message);
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.outcomes).toHaveLength(CORPUS_ENGINE_TEST_FILES.length);
  for (const file of CORPUS_ENGINE_TEST_FILES) {
    expect(
      messages.some(
        (message) =>
          message.startsWith(`PASS ${file}:`) && /\d+\.\d+s/u.test(message),
      ),
    ).toBe(true);
  }
});

test("all files run with at most three active suites and every failure is named", async () => {
  const planned = suites();
  const started: string[] = [];
  const messages: string[] = [];
  let active = 0;
  let peak = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = runCorpusEngineSuites({
    suites: planned,
    execute: async ({ file }) => {
      started.push(file);
      active += 1;
      peak = Math.max(peak, active);
      await barrier;
      active -= 1;
      return {
        exitCode:
          file === planned.at(0)?.file || file === planned.at(-1)?.file ? 2 : 0,
      };
    },
    signal: new AbortController().signal,
    report: (message) => {
      messages.push(message);
    },
  });
  expect(active).toBe(3);
  release();
  const result = await running;
  expect(peak).toBe(3);
  expect(started).toEqual(planned.map(({ file }) => file));
  expect(result.exitCode).toBe(1);
  for (const { file } of planned.filter(
    (_, index) => index === 0 || index === planned.length - 1,
  )) {
    expect(
      messages.some(
        (message) => message === `Failed corpus engine suite: ${file}`,
      ),
    ).toBe(true);
  }
});

test("a genuinely signalled Bun child fails even when its exit code is null", async () => {
  const messages: string[] = [];
  const result = await runCorpusEngineSuites({
    suites: suites().slice(0, 1),
    execute: async () => {
      const child = Bun.spawn(
        [process.execPath, "--eval", "process.kill(process.pid, 'SIGTERM')"],
        { stdout: "ignore", stderr: "ignore" },
      );
      await child.exited;
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGTERM");
      return { exitCode: child.exitCode, signalCode: child.signalCode };
    },
    signal: new AbortController().signal,
    report: (message) => {
      messages.push(message);
    },
  });
  expect(result.exitCode).toBe(1);
  expect(messages.join("\n")).toContain("signal=SIGTERM");
});

test("executor rejection is reported and does not omit other suites", async () => {
  const messages: string[] = [];
  const result = await runCorpusEngineSuites({
    suites: suites(),
    execute: async () => {
      throw new TypeError("fixture execution failed");
    },
    signal: new AbortController().signal,
    report: (message) => {
      messages.push(message);
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.outcomes).toHaveLength(CORPUS_ENGINE_TEST_FILES.length);
  expect(
    messages.filter((message) => message.includes("fixture execution failed")),
  ).toHaveLength(CORPUS_ENGINE_TEST_FILES.length);
});

test("cancellation stops pending launches and records interrupted files", async () => {
  const abort = new AbortController();
  const started: string[] = [];
  const result = await runCorpusEngineSuites({
    suites: suites(),
    execute: async ({ file }) => {
      started.push(file);
      abort.abort();
      return { exitCode: 0 };
    },
    signal: abort.signal,
    report: () => {},
  });
  expect(result.exitCode).toBe(1);
  expect(started).toHaveLength(1);
  expect(
    result.outcomes.filter(({ exitCode }) => exitCode === null),
  ).toHaveLength(CORPUS_ENGINE_TEST_FILES.length - 1);
});

test("each suite and each run own distinct output, data, report and container names", () => {
  const planned = [
    ...suites(),
    ...planCorpusEngineSuites({
      outputRoot: "/tmp/corpus-runner-test",
      runId: "another",
    }),
  ];
  for (const field of [
    "outputDir",
    "dataDir",
    "junitPath",
    "containerName",
  ] as const) {
    expect(new Set(planned.map((suite) => suite[field])).size).toBe(
      planned.length,
    );
  }
});

test("coverage enumerates the real sources and detects added and removed gated files", async () => {
  await assertCorpusEngineTestCoverage(apiRoot);
  const fixture = mkdtempSync(path.join(tmpdir(), "corpus-coverage-"));
  // This is generated fixture source, not a gate on this always-running suite.
  const gatedSource = `const enabled = process.env[${JSON.stringify(CORPUS_ENGINE_GATE)}] === "true";`;
  try {
    for (const file of CORPUS_ENGINE_TEST_FILES) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), gatedSource);
    }
    await assertCorpusEngineTestCoverage(fixture);
    const extra = "src/new-corpus-engine.test.ts";
    writeFileSync(path.join(fixture, extra), gatedSource);
    expect(
      await rejectionOf(assertCorpusEngineTestCoverage(fixture)),
    ).toMatchObject({
      message: expect.stringContaining(`unlisted=${extra}`),
    });
    rmSync(path.join(fixture, extra));
    const removed = CORPUS_ENGINE_TEST_FILES[0];
    rmSync(path.join(fixture, removed));
    expect(
      await rejectionOf(assertCorpusEngineTestCoverage(fixture)),
    ).toMatchObject({
      message: expect.stringContaining(`stale=${removed}`),
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("JUnit execution guard", () => {
  test.each([
    ["empty", "<testsuites/>"],
    ["malformed", "<testsuites>"],
    ["skipped", "<testsuite><testcase><skipped/></testcase></testsuite>"],
    ["failure", "<testsuite><testcase><failure/></testcase></testsuite>"],
    ["error", "<testsuite><testcase><error/></testcase></testsuite>"],
    ["disabled", '<testsuite disabled="1"><testcase/></testsuite>'],
    ["aggregate skipped", '<testsuite skipped="1"><testcase/></testsuite>'],
    ["aggregate failures", '<testsuite failures="1"><testcase/></testsuite>'],
  ])("rejects %s reports", async (_name, xml) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "corpus-report-"));
    try {
      const report = path.join(fixture, "tests.xml");
      writeFileSync(report, xml);
      const child = Bun.spawn(
        ["python3", "-c", CORPUS_ENGINE_REPORT_CHECK, report],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(await child.exited).not.toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("accepts an executed passing test", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "corpus-report-"));
    try {
      const report = path.join(fixture, "tests.xml");
      writeFileSync(
        report,
        '<testsuite tests="1"><testcase name="executed"/></testsuite>',
      );
      const child = Bun.spawn(
        ["python3", "-c", CORPUS_ENGINE_REPORT_CHECK, report],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toContain(
        "Executed 1 engine tests",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

test("later isolated preload overrides setup defaults and rejects an inactive gate", async () => {
  const command = [
    process.execPath,
    "--preload",
    "./src/tests/setup-env.ts",
    "--preload",
    "./scripts/corpus-engine-test-env.ts",
    "--eval",
    "console.log(JSON.stringify([process.env.CORPUS_INDEX_Q09_ENDPOINT, process.env.CORPUS_INDEX_Q09_SEARCH_ENDPOINT]))",
  ];
  const env = {
    ...process.env,
    STELLA_RUN_CORPUS_ENGINE_TESTS: "true",
    STELLA_CORPUS_ENGINE_TEST_ENDPOINT: "http://127.0.0.1:49123",
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7290",
  };
  const child = Bun.spawn(command, {
    cwd: apiRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe(
    '["http://127.0.0.1:49123","http://127.0.0.1:49123"]',
  );
  const rejected = Bun.spawn(command, {
    cwd: apiRoot,
    env: { ...env, STELLA_RUN_CORPUS_ENGINE_TESTS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rejected.exited).not.toBe(0);
  expect(await new Response(rejected.stderr).text()).toContain(
    "Corpus engine preload requires the isolated suite runner",
  );
});
