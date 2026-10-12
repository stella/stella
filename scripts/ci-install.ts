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
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const INSTALL_TIMEOUT_MS = 120_000;
// Windows Bun 1.4.3 completed 1,680 extractions from a 2,502-package resolved
// graph before a cold install reached 120 s. Linear projection is 179 s;
// 240 s adds 34% margin.
// Count all packages conservatively, including those skipped on this platform.
const WINDOWS_COLD_INSTALL_TIMEOUT_MS = 240_000;

export const installTimeoutMs = (platform: NodeJS.Platform) =>
  platform === "win32" ? WINDOWS_COLD_INSTALL_TIMEOUT_MS : INSTALL_TIMEOUT_MS;
const CONSOLE_TAIL_BYTES = 4096;

type LoggedInstallOptions = {
  command: readonly string[];
  logFile: string;
  timeoutMs?: number;
  report?: (message: string) => void;
  timeoutDiagnostics?: (pid: number) => string;
  writeLog?: (descriptor: number, chunk: Uint8Array) => void;
};

export const runLoggedInstall = async ({
  command,
  logFile,
  timeoutMs = installTimeoutMs(process.platform),
  writeLog = (descriptor, chunk) => {
    writeSync(descriptor, chunk);
  },
  report = (message) => {
    process.stdout.write(message);
  },
  timeoutDiagnostics = (pid) => {
    if (process.platform !== "linux") {
      return `Install timeout diagnostics unavailable on ${process.platform}\n`;
    }
    const result = Bun.spawnSync(
      [
        "bash",
        path.join(import.meta.dir, "ci-install-timeout-diagnostics.sh"),
        String(pid),
        process.env["BUN_INSTALL_CACHE_DIR"] ??
          path.join(homedir(), ".bun/install/cache"),
        tmpdir(),
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    return `${result.stdout.toString()}${result.stderr.toString()}\nDiagnostic command exit ${childExitStatus(result)}\n`;
  },
}: LoggedInstallOptions) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const descriptor = openSync(logFile, "w+");
  const record = (chunk: string | Uint8Array) => {
    writeLog(
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
    });
    let captured = false;
    const deadline = setTimeout(() => {
      captured = true;
      try {
        summary(
          `Install deadline reached; capturing state before SIGKILL\n${timeoutDiagnostics(child.pid)}`,
        );
      } catch (error) {
        summary(`Install diagnostic capture failed: ${String(error)}\n`);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    // Verbose extraction can emit hundreds of thousands of lines. Keep the
    // artifact complete without coupling install throughput to the CI console.
    try {
      await Promise.all([
        child.stdout.pipeTo(new WritableStream({ write: record })),
        child.stderr.pipeTo(new WritableStream({ write: record })),
        child.exited,
      ]);
    } catch (error) {
      // A failed recorder must not leave an installer alive after its pipes fail.
      // Keep the deadline armed until the process is reaped.
      try {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      } finally {
        await child.exited;
      }
      throw error;
    } finally {
      clearTimeout(deadline);
    }
    if (child.signalCode === "SIGKILL" && !captured) {
      summary(timeoutDiagnostics(child.pid));
    }
    const exitCode = captured ? 1 : childExitStatus(child);
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
    timeoutMs: installTimeoutMs(process.platform),
  });
}
