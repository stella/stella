import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";
import {
  createProcessMemoryReader,
  testInvocationMemoryLimit,
  watchTestProcessMemory,
} from "@stll/scripts/src/process-memory";
import { attachTestProcessShutdown } from "@stll/scripts/src/process-shutdown";
import { spawnTestProcess } from "@stll/scripts/src/process-spawn";
import { forwardTestStderr } from "@stll/scripts/src/process-stderr";
import { warmReactCompilerCache } from "@stll/scripts/src/react-compiler-bun-plugin";

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

const laneCount =
  process.env["CI"] === "true" && availableParallelism() >= 4 ? 2 : 1;

const { runs, missingPaths } = planTestRuns({
  argv: Bun.argv.slice(2),
  pathKind,
  testFilesIn,
  domShards: laneCount,
});
if (missingPaths.length > 0) {
  console.error(`No such test path: ${missingPaths.join(", ")}`);
  process.exit(1);
}
if (runs.length === 0) {
  console.error("No test files matched the given paths.");
  process.exit(1);
}

// The test preload compiles every source module with the React Compiler, and
// an isolated run loads the module graph once per test file. Compiling the
// sources here first lets those test files read cached output instead of
// each loading the compiler.
const REPOSITORY_ROOT = path.resolve(WEB_ROOT_PATH, "../..");
const COMPILED_SOURCE_GLOBS = [
  "apps/web/src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
];
warmReactCompilerCache(
  COMPILED_SOURCE_GLOBS.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({
      cwd: REPOSITORY_ROOT,
      absolute: true,
    }),
  ]).filter((file) => !file.split(path.sep).includes("node_modules")),
);

const limitBytes = testInvocationMemoryLimit(process.env);
const readBytes = await createProcessMemoryReader();

const createBufferedWritable = () => {
  const chunks: Uint8Array[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(
        typeof chunk === "string"
          ? new TextEncoder().encode(chunk)
          : new Uint8Array(chunk),
      );
      callback();
    },
  });
  return { chunks, stream };
};

const flushChunks = (
  target: NodeJS.WriteStream,
  chunks: readonly Uint8Array[],
) => {
  for (const chunk of chunks) {
    target.write(chunk);
  }
};

type RunOutcome = {
  readonly label: string;
  readonly exitCode: number;
  readonly interrupted: boolean;
};

const executeRun = async (
  run: (typeof runs)[number],
  buffered: boolean,
): Promise<RunOutcome> => {
  let currentFile =
    run.args
      .filter((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg))
      .join(", ") || `${run.label} suite (before first file)`;
  const stderrBuffer = buffered ? createBufferedWritable() : undefined;
  const stdoutChunks: Uint8Array[] = [];
  const { child, windowsProcesses } = spawnTestProcess({
    limitBytes,
    command: ["bun", "--smol", "test", ...run.args],
    options: {
      cwd: WEB_ROOT_PATH,
      stdin: "inherit",
      stdout: buffered ? "pipe" : "inherit",
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
  const stdoutReader =
    buffered && child.stdout instanceof ReadableStream
      ? child.stdout.getReader()
      : undefined;
  const stdoutDrain =
    stdoutReader === undefined
      ? Promise.resolve()
      : (async () => {
          for (;;) {
            const { done, value } = await stdoutReader.read();
            if (done) {
              return;
            }
            stdoutChunks.push(value);
          }
        })();
  let outputFailure: string | undefined;
  try {
    const decoder = new TextDecoder();
    let pending = "";
    const output = await forwardTestStderr({
      child,
      destination: stderrBuffer?.stream ?? process.stderr,
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
    if (stdoutReader !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        stdoutDrain.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(true);
          }, 1000);
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (timedOut) {
        const ignoreCancel = (error: unknown) => {
          process.stderr.write(
            `Could not cancel stdout for ${run.label}: ${String(error)}\n`,
          );
        };
        await stdoutReader.cancel().catch(ignoreCancel);
        await stdoutDrain.catch(ignoreCancel);
      }
    }
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
  if (buffered) {
    process.stdout.write(`=== web test suite: ${run.label} ===\n`);
    flushChunks(process.stdout, stdoutChunks);
    if (stderrBuffer !== undefined) {
      flushChunks(process.stderr, stderrBuffer.chunks);
    }
  }
  const interruptedExitCode = shutdown.exitCode();
  if (interruptedExitCode !== undefined) {
    return {
      label: run.label,
      exitCode: interruptedExitCode,
      interrupted: true,
    };
  }
  const status = childExitStatus(child);
  if (
    outputFailure !== undefined ||
    watchdog.failure() !== undefined ||
    status !== 0
  ) {
    console.error(`The ${run.label} tests failed.`);
    return {
      label: run.label,
      exitCode:
        outputFailure === undefined && watchdog.failure() === undefined
          ? status
          : 1,
      interrupted: false,
    };
  }
  return { label: run.label, exitCode: 0, interrupted: false };
};

const activeLanes = Math.min(laneCount, runs.length);
if (activeLanes <= 1) {
  for (const run of runs) {
    const outcome = await executeRun(run, false);
    if (outcome.exitCode !== 0) {
      process.exit(outcome.exitCode);
    }
  }
} else {
  let nextIndex = 0;
  let firstFailure: RunOutcome | undefined;
  let interrupted = false;
  const worker = async () => {
    while (!interrupted) {
      const current = nextIndex;
      if (current >= runs.length) {
        return;
      }
      nextIndex += 1;
      const run = runs[current];
      if (run === undefined) {
        return;
      }
      const outcome = await executeRun(run, true);
      if (outcome.interrupted) {
        interrupted = true;
        firstFailure ??= outcome;
        return;
      }
      if (outcome.exitCode !== 0) {
        firstFailure ??= outcome;
      }
    }
  };
  await Promise.all(
    Array.from({ length: activeLanes }, async () => await worker()),
  );
  if (firstFailure !== undefined) {
    process.exit(firstFailure.exitCode);
  }
}
