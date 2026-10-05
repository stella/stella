// CI's explicit cold installs share a two-minute bound and an incrementally
// written verbose log. The enclosing step has a longer timeout, leaving time
// for the failure artifact to upload even when Bun's installer hangs.
// Only built-ins and the dependency-free exit-status owner are reachable before
// dependencies exist.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const INSTALL_TIMEOUT_MS = 120_000;

type LoggedInstallOptions = {
  command: readonly string[];
  logFile: string;
  timeoutMs?: number;
};

export const runLoggedInstall = async ({
  command,
  logFile,
  timeoutMs = INSTALL_TIMEOUT_MS,
}: LoggedInstallOptions) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const descriptor = openSync(logFile, "w");
  const record = (chunk: string | Uint8Array) => {
    writeSync(
      descriptor,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
    process.stdout.write(chunk);
  };
  try {
    record(`Install started; process limit ${timeoutMs} ms\n`);
    const child = Bun.spawn({
      cmd: [...command],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    await Promise.all([
      child.stdout.pipeTo(new WritableStream({ write: record })),
      child.stderr.pipeTo(new WritableStream({ write: record })),
      child.exited,
    ]);
    const exitCode = childExitStatus(child);
    record(
      `Install finished; exit ${exitCode}; signal ${child.signalCode ?? "none"}\n`,
    );
    return exitCode;
  } finally {
    closeSync(descriptor);
  }
};

if (import.meta.main) {
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
  });
}
