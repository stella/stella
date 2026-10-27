// CI installs retain verbose evidence. Budgets warn; only a lack of progress
// kills the installer. The job deadline bounds the complete operation.
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
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { parseInstallFlags } from "./ci-install-store";

const INSTALL_WARNING_BUDGET_MS = 120_000;
// Windows Bun 1.4.3 completed 1,680 extractions from a 2,502-package resolved
// graph before a cold install reached 120 s. Linear projection is 179 s;
// 240 s adds 34% margin.
// Count all packages conservatively, including those skipped on this platform.
const WINDOWS_COLD_INSTALL_WARNING_BUDGET_MS = 240_000;

class CiInstallBudgetError extends Error {
  override name = "CiInstallBudgetError";
  readonly _tag = "CiInstallBudgetError";
}

export const installWarningBudgetMs = (
  platform: NodeJS.Platform,
  requested?: string,
) => {
  const maximum =
    platform === "win32"
      ? WINDOWS_COLD_INSTALL_WARNING_BUDGET_MS
      : INSTALL_WARNING_BUDGET_MS;
  if (requested === undefined || requested === "") {
    return maximum;
  }
  const budget = Number(requested);
  if (
    !/^[1-9]\d*$/u.test(requested) ||
    !Number.isSafeInteger(budget) ||
    budget > maximum
  ) {
    throw new CiInstallBudgetError(
      "Installer budget must be positive integer milliseconds within the platform limit",
    );
  }
  return budget;
};
const CONSOLE_TAIL_BYTES = 4096;
// Retained logs buffer installer output: the longest observed console gap was
// 120.039 s, censored by the old killer. Five times that upper-bound observation
// rounds up to 610 s; this is conservative until timestamped progress is retained.
export const INSTALL_STALL_MS = 610_000;

export type InstallRestoreOutcome = "hit" | "cold";

type InstallWatchdogOptions = {
  budgetMs: number;
  stallMs: number;
  now: () => number;
  warn: () => void;
  kill: () => void;
};

export const createInstallWatchdog = ({
  budgetMs,
  stallMs,
  now,
  warn,
  kill,
}: InstallWatchdogOptions) => {
  const started = now();
  let progressAt = started;
  let warned = false;
  let stalled = false;
  let maximumGap = 0;
  const warning = () => {
    if (!warned && now() - started >= budgetMs) {
      warned = true;
      warn();
    }
  };
  return {
    progress: () => {
      maximumGap = Math.max(maximumGap, now() - progressAt);
      progressAt = now();
    },
    maximumGapMs: () => Math.max(maximumGap, now() - progressAt),
    finish: warning,
    wasStalled: () => stalled,
    idleMs: () => now() - progressAt,
    tick: () => {
      warning();
      if (!stalled && now() - progressAt >= stallMs) {
        stalled = true;
        kill();
      }
    },
  };
};

// Only inspect the store when output has stopped. Include metadata as well as
// sizes so extraction and hardlinking count as progress without console output.
export const installStoreProgress = async (
  roots: readonly string[],
  active = () => true,
) => {
  let files = 0;
  let bytes = 0;
  let modified = 0;
  let newest = 0;
  const pending = [...roots];
  for (const directory of pending) {
    if (!active()) {
      break;
    }
    try {
      const directoryMetadata = await stat(directory);
      modified += directoryMetadata.mtimeMs;
      newest = Math.max(newest, directoryMetadata.mtimeMs);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!active()) {
          break;
        }
        const filename = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        const metadata = await stat(filename);
        files += 1;
        bytes += metadata.size;
        modified += metadata.mtimeMs;
        newest = Math.max(newest, metadata.mtimeMs);
        if (entry.isDirectory()) {
          pending.push(filename);
        }
      }
    } catch (error) {
      // Extraction can rename/remove a path while it is sampled.
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
  return { signature: `${files}:${bytes}:${modified}`, newest };
};

// Bun returns null at runtime for ordinary exits despite its signalCode type.
const installTerminationSignal = (signal: string | number | null | undefined) =>
  signal ?? undefined;

type LoggedInstallOptions = {
  command: readonly string[];
  logFile: string;
  budgetMs?: number;
  stallMs?: number;
  restoreOutcome?: InstallRestoreOutcome;
  storeKey?: string | undefined;
  progressRoots?: readonly string[];
  report?: (message: string) => void;
};

export const runLoggedInstall = async ({
  command,
  logFile,
  budgetMs = installWarningBudgetMs(process.platform),
  stallMs = INSTALL_STALL_MS,
  restoreOutcome = "cold",
  storeKey = "unavailable",
  progressRoots = [
    process.env["BUN_INSTALL_CACHE_DIR"] ??
      path.join(homedir(), ".bun/install/cache"),
    path.join(process.cwd(), "node_modules"),
  ],
  report = (message) => {
    process.stdout.write(message);
  },
}: LoggedInstallOptions) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const descriptor = openSync(logFile, "w+");
  const started = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sampling: Promise<void> | undefined;
  const completion = new AbortController();
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
    const child = Bun.spawn({
      cmd: [...command],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = createInstallWatchdog({
      budgetMs,
      stallMs,
      now: Date.now,
      warn: () =>
        summary(
          `::warning title=install-budget::kind=infra class=${restoreOutcome === "cold" ? "install-cold-budget" : "install-budget"} ${telemetry()}\n`,
        ),
      kill: () => {
        summary(
          `::error title=install-stall::kind=infra class=install-stall ${telemetry()} idle_ms=${watchdog.idleMs()} pid=${child.pid}\n`,
        );
        child.kill("SIGKILL");
      },
    });
    const telemetry = () =>
      `restore=${restoreOutcome} key=${storeKey} install_ms=${Date.now() - started} budget_ms=${budgetMs} stall_ms=${stallMs} max_progress_gap_ms=${watchdog.maximumGapMs()}`;
    summary(
      `Install started; warning budget ${budgetMs} ms; ${telemetry()}; log ${logFile}\n`,
    );
    let previousStore: string | undefined;
    let lastProbe = started;
    const probeStore = async () => {
      try {
        const store = await installStoreProgress(
          progressRoots,
          () => !completion.signal.aborted,
        );
        if (completion.signal.aborted) {
          return;
        }
        if (
          (previousStore !== undefined && store.signature !== previousStore) ||
          (store.newest >= started && previousStore === undefined)
        ) {
          watchdog.progress();
        }
        previousStore = store.signature;
        watchdog.tick();
      } catch (error) {
        // An unreadable store cannot prove a stall. Keep the job deadline and
        // surface the failed probe rather than killing a progressing install.
        if (!completion.signal.aborted) {
          summary(`::warning title=install-progress-probe::${String(error)}\n`);
        }
      } finally {
        sampling = undefined;
      }
    };
    timer = setInterval(
      () => {
        if (completion.signal.aborted || sampling !== undefined) {
          return;
        }
        watchdog.finish();
        const probeInterval = Math.min(10_000, stallMs / 2);
        if (watchdog.idleMs() < probeInterval) {
          watchdog.tick();
          return;
        }
        if (Date.now() - lastProbe < probeInterval) {
          return;
        }
        lastProbe = Date.now();
        sampling = probeStore();
      },
      Math.min(1000, stallMs / 2),
    );
    const output = (chunk: Uint8Array) => {
      if (chunk.byteLength > 0) {
        watchdog.progress();
      }
      record(chunk);
    };
    // Verbose extraction can emit hundreds of thousands of lines. Keep the
    // artifact complete without coupling install throughput to the CI console.
    await Promise.all([
      child.stdout.pipeTo(new WritableStream({ write: output })),
      child.stderr.pipeTo(new WritableStream({ write: output })),
      child.exited,
    ]);
    completion.abort();
    clearInterval(timer);
    await sampling;
    watchdog.finish();
    const exitCode = childExitStatus(child);
    if (exitCode !== 0) {
      const size = fstatSync(descriptor).size;
      const length = Math.min(size, CONSOLE_TAIL_BYTES);
      const tail = Buffer.alloc(length);
      readSync(descriptor, tail, 0, length, size - length);
      report(`Installer log tail:\n${tail.toString()}\n`);
    }
    const signal = installTerminationSignal(child.signalCode);
    if (signal !== undefined && !watchdog.wasStalled()) {
      summary(
        `::error title=install-signal::kind=infra class=install-signal ${telemetry()} signal=${signal}\n`,
      );
    }
    summary(
      `Install finished; exit ${exitCode}; signal ${signal ?? "none"}; ${telemetry()}\n`,
    );
    return exitCode;
  } finally {
    completion.abort();
    if (timer !== undefined) {
      clearInterval(timer);
    }
    await sampling;
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
  const flags =
    args.length > 0
      ? args
      : parseInstallFlags(process.env["STELLA_CI_INSTALL_FLAGS"]);
  process.exitCode = await runLoggedInstall({
    command: [process.execPath, "install", "--verbose", ...flags],
    logFile,
    restoreOutcome:
      process.env["STELLA_CI_INSTALL_RESTORE"] === "hit" ? "hit" : "cold",
    storeKey: process.env["STELLA_CI_INSTALL_KEY"],
    budgetMs: installWarningBudgetMs(
      process.platform,
      process.env["STELLA_CI_INSTALL_BUDGET_MS"],
    ),
  });
}
