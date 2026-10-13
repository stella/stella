import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";
import {
  createProcessMemoryReader,
  testInvocationMemoryLimit,
  watchTestProcessMemory,
} from "@stll/scripts/src/process-memory";
import { attachTestProcessShutdown } from "@stll/scripts/src/process-shutdown";
import { forwardTestStderr } from "@stll/scripts/src/process-stderr";
import { spawnTestProcess } from "@stll/scripts/src/test-process-spawn";

import { planTestRuns } from "./test-run-plan";
import type { PathKind } from "./test-run-plan";

const WEB_ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const TEST_FILE_GLOB = new Bun.Glob("**/*.test.{ts,tsx}");

const pathKind = (arg: string): PathKind => {
  try {
    const stats = statSync(path.resolve(WEB_ROOT_PATH, arg));
    return stats.isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
};

const testFilesIn = (directory: string): readonly string[] =>
  [
    ...TEST_FILE_GLOB.scanSync({
      cwd: path.resolve(WEB_ROOT_PATH, directory),
    }),
  ]
    .filter((file) => !file.split(path.sep).includes("node_modules"))
    .map((file) => path.join(directory, file))
    .toSorted();

const { runs, missingPaths } = planTestRuns({
  argv: Bun.argv.slice(2),
  pathKind,
  testFilesIn,
});
if (missingPaths.length > 0) {
  console.error(`No such test path: ${missingPaths.join(", ")}`);
  process.exit(1);
}
if (runs.length === 0) {
  console.error("No test files matched the given paths.");
  process.exit(1);
}

const limitBytes = testInvocationMemoryLimit(process.env);
const readBytes = await createProcessMemoryReader();
for (const run of runs) {
  let currentFile =
    run.args
      .filter((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg))
      .join(", ") || `${run.label} suite (before first file)`;
  const { child, windowsProcesses } = spawnTestProcess({
    command: ["bun", "--smol", "test", ...run.args],
    options: {
      cwd: WEB_ROOT_PATH,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "pipe",
      detached: process.platform !== "win32",
    },
    onWarning: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
  const shutdown = attachTestProcessShutdown({
    windowsProcesses,
    child,
    termination: process.platform === "win32" ? "process" : "group",
    onWarning: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
  const watchdog = watchTestProcessMemory({
    windowsProcesses: shutdown.windowsProcesses,
    child,
    limitBytes,
    readBytes,
    file: () => currentFile,
    onFailure: (message) => {
      process.stderr.write(`${message}\n`);
    },
    onWarning: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
  let outputFailure: string | undefined;
  try {
    const decoder = new TextDecoder();
    let pending = "";
    const output = await forwardTestStderr({
      child,
      destination: process.stderr,
      onWarning: (message) => {
        process.stderr.write(`${message}\n`);
      },
      onChunk: (chunk) => {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = (lines.pop() ?? "").slice(-16 * 1024);
        for (const line of lines) {
          const match = /^(.+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/u.exec(
            Bun.stripANSI(line),
          );
          if (match?.[1] !== undefined) {
            currentFile = match[1];
          }
        }
      },
    });
    if (output.isErr()) {
      outputFailure = output.error.message;
      process.stderr.write(`${outputFailure}\n`);
    }
  } finally {
    await watchdog.stop();
    shutdown.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  const interruptedExitCode = shutdown.exitCode();
  if (interruptedExitCode !== undefined) {
    process.exit(interruptedExitCode);
  }
  if (
    outputFailure !== undefined ||
    watchdog.failure() !== undefined ||
    childExitStatus(child) !== 0
  ) {
    console.error(`The ${run.label} tests failed.`);
    process.exit(
      outputFailure === undefined && watchdog.failure() === undefined
        ? childExitStatus(child)
        : 1,
    );
  }
}
