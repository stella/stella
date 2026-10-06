import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildApiTestCommand } from "./api-test-command";
import { readTimingArtifact } from "./test-timings";

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
