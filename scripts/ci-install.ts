// CI installs retain an incrementally written verbose log and a bounded runtime.
// The enclosing step has a longer timeout, leaving time
// for the failure artifact to upload even when Bun's installer hangs.
// Only built-ins and the dependency-free exit-status owner are reachable before
// dependencies exist.
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const INSTALL_TIMEOUT_MS = 120_000;
// Windows Bun 1.4.3 completed 1,680 extractions from a 2,502-package resolved
// graph before a cold install reached 120 s. Linear projection is 179 s;
// 240 s adds 34% margin.
// Count all packages conservatively, including those skipped on this platform.
const WINDOWS_COLD_INSTALL_TIMEOUT_MS = 240_000;

export const installTimeoutMs = (
  cacheRestored: "true" | "false" | undefined,
) => {
  if (cacheRestored === undefined) {
    return INSTALL_TIMEOUT_MS;
  }
  return cacheRestored === "true"
    ? INSTALL_TIMEOUT_MS
    : WINDOWS_COLD_INSTALL_TIMEOUT_MS;
};
const CONSOLE_TAIL_BYTES = 4096;

type LoggedInstallOptions = {
  command: readonly string[];
  logFile: string;
  timeoutMs?: number;
  report?: (message: string) => void;
};

export const runLoggedInstall = async ({
  command,
  logFile,
  timeoutMs = INSTALL_TIMEOUT_MS,
  report = (message) => {
    process.stdout.write(message);
  },
}: LoggedInstallOptions) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const descriptor = openSync(logFile, "w+");
  const record = (chunk: string | Uint8Array) => {
    writeSync(
      descriptor,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
  };
  const summary = (message: string) => {
    record(message);
    report(message);
  };
  try {
    summary(`Install started; process limit ${timeoutMs} ms; log ${logFile}\n`);
    const child = Bun.spawn({
      cmd: [...command],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    // Verbose extraction can emit hundreds of thousands of lines. Keep the
    // artifact complete without coupling install throughput to the CI console.
    await Promise.all([
      child.stdout.pipeTo(new WritableStream({ write: record })),
      child.stderr.pipeTo(new WritableStream({ write: record })),
      child.exited,
    ]);
    const exitCode = childExitStatus(child);
    if (exitCode !== 0) {
      const size = fstatSync(descriptor).size;
      const length = Math.min(size, CONSOLE_TAIL_BYTES);
      const tail = Buffer.alloc(length);
      readSync(descriptor, tail, 0, length, size - length);
      report(`Installer log tail:\n${tail.toString()}\n`);
    }
    summary(
      `Install finished; exit ${exitCode}; signal ${child.signalCode ?? "none"}\n`,
    );
    return exitCode;
  } finally {
    closeSync(descriptor);
  }
};

if (import.meta.main) {
  const cacheRestored = process.env["CI_INSTALL_CACHE_RESTORED"];
  if (
    cacheRestored !== undefined &&
    cacheRestored !== "true" &&
    cacheRestored !== "false"
  ) {
    console.error("CI_INSTALL_CACHE_RESTORED must be true or false");
    process.exit(1);
  }
  const [logFile, ...args] = process.argv.slice(2);
  if (logFile === undefined || logFile === "") {
    console.error(
      "Usage: bun scripts/ci-install.ts <log-file> [install flags]",
    );
    process.exit(1);
  }
  process.exitCode = await runLoggedInstall({
    command: [process.execPath, "install", "--verbose", ...args],
    logFile,
    timeoutMs: installTimeoutMs(cacheRestored),
  });
}
