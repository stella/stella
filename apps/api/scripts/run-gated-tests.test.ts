import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runTestBatches } from "./run-gated-tests";

test("a failed ordinary batch still produces one report with later isolated suites", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-gated-runner-"),
  );
  const outfile = path.join(directory, "final.xml");
  const batches = [
    ["ordinary.test.ts"],
    ["isolated-one.test.ts"],
    ["isolated-two.test.ts"],
  ] as const;
  const statuses = [7, 0, 9];
  const calls: string[][] = [];

  try {
    const status = await runTestBatches({
      batches,
      bunArguments: ["--reporter=junit", `--reporter-outfile=${outfile}`],
      cwd: directory,
      gate: "POSTGRES_TESTS",
      gateValue: "1",
      spawn: (options) => {
        const command = [...options.cmd];
        calls.push(command);
        const batchIndex = calls.length - 1;
        const outfileArgument = command.find((argument) =>
          argument.startsWith("--reporter-outfile="),
        );
        const batchOutfile = outfileArgument?.split("=").at(1);
        if (batchOutfile === undefined) {
          throw new Error("Expected a rewritten reporter outfile.");
        }
        const batch = batches.at(batchIndex);
        if (batch === undefined) {
          throw new Error("Expected a test batch.");
        }
        const reportWritten = Bun.write(
          batchOutfile,
          `<testsuites tests="1" failures="${batchIndex === 0 ? "1" : "0"}" errors="0" skipped="0" time="1"><testsuite name="${batch[0]}" /></testsuites>`,
        );
        const exitCode = statuses.at(batchIndex) ?? 1;
        return {
          exited: reportWritten.then(() => exitCode),
          exitCode,
          signalCode: null,
        };
      },
    });

    expect(status).toBe(7);
    expect(calls).toHaveLength(3);
    const report = await Bun.file(outfile).text();
    expect(report).toContain(
      '<testsuites tests="3" failures="1" errors="0" skipped="0" time="3">',
    );
    for (const [index, [suite]] of batches.entries()) {
      expect(report).toContain(`name="${suite}"`);
      if (index > 0) {
        expect(report.indexOf(suite)).toBeGreaterThan(
          report.indexOf(batches.at(index - 1)?.at(0) ?? ""),
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
