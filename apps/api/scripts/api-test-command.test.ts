import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildApiTestCommand } from "./api-test-command";
import { readTimingArtifact } from "./test-timings";

test("environment setup remains usable by generators outside the test runner", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dirname, "../src/tests/setup-env.ts"),
      "-e",
      'console.log("environment-preload-ready")',
    ],
    {
      env: { ...process.env, NODE_ENV: "production", STELLA_LOCAL_DEV: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout.trim()).toBe("environment-preload-ready");
});

test("fixture lifecycle preloading leaves runtime mode resolution to the test", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-fixture-preload-"));
  try {
    const file = path.join(directory, "runtime-mode.test.ts");
    const runtimeMode = path.join(
      import.meta.dirname,
      "../src/runtime-mode.ts",
    );
    writeFileSync(
      file,
      `import { test, expect } from "bun:test";
process.env.NODE_ENV = "production";
delete process.env.STELLA_LOCAL_DEV;
const { isLocalDevOpen, isLocalTestRun } = await import(${JSON.stringify(runtimeMode)});
test("strict fixture runtime", () => {
  expect(isLocalDevOpen()).toBe(false);
  expect(isLocalTestRun()).toBe(false);
});`,
    );
    const child = Bun.spawn(
      buildApiTestCommand({
        bunExecutable: process.execPath,
        bunRuntimeArguments: [],
        testArguments: [
          "--preload",
          path.join(import.meta.dirname, "../src/tests/setup-env.ts"),
        ],
        testFiles: [file],
        timingsDirectory: directory,
      }),
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(stderr).toContain("1 pass");
    expect(exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("commands record whole-file setup time in independent artifacts without altering test selection", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-timings-"));
  try {
    const file = path.join(directory, "setup.test.ts");
    writeFileSync(
      file,
      'import {beforeAll, test, expect} from "bun:test"; await Bun.sleep(30); beforeAll(async () => { await Bun.sleep(40); }); test("body", () => expect(1).toBe(1));',
    );
    const options = {
      bunExecutable: process.execPath,
      bunRuntimeArguments: [],
      testArguments: [],
      testFiles: [file],
      timingsDirectory: directory,
    };
    const command = buildApiTestCommand(options);
    const next = buildApiTestCommand(options);
    const output = command
      .find((arg) => arg.startsWith("--timings="))
      ?.slice("--timings=".length);
    expect(output).toBeDefined();
    expect(command.at(-1)).toBe(file);
    expect(next).not.toEqual(command);
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(stderr).toContain("1 pass");
    expect(exitCode).toBe(0);
    if (output === undefined) {
      panic("Missing timing output");
    }
    const timings = Object.values(
      readTimingArtifact(readFileSync(output, "utf-8")),
    );
    expect(timings).toHaveLength(1);
    expect(timings.at(0)).toBeGreaterThanOrEqual(0.06);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
