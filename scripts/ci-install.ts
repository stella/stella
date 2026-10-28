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
// Across 40 healthy timestamped CI installs (26 store hits and 14 cold), the
// largest progress gap was 632 ms and the slowest cold install took 18.2 s.
// A 60 s no-progress window therefore leaves ample headroom without relying on
// buffered console gaps; the single retry remains the recovery boundary.
export const INSTALL_STALL_MS = 60_000;

export type InstallRestoreOutcome = "hit" | "cold" | "partial" | "uncached";

export type InstallAttemptResult = { exitCode: number; stalled: boolean };

export const retryStalledInstall = async (
  run: (attempt: number) => Promise<InstallAttemptResult>,
) => {
  const first = await run(1);
  if (!first.stalled) {
    return { ...first, retried: false };
  }
  const second = await run(2);
  return { ...second, retried: true };
};

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
  now?: () => number;
  record?: (descriptor: number, chunk: Uint8Array) => void;
  sampleStore?: typeof installStoreProgress;
  inspectProcess?: (pid: number, storeDirectory: string) => Promise<string>;
  scheduleInterval?: (callback: () => void, milliseconds: number) => () => void;
  spawn?: (command: readonly string[]) => {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    exitCode: number | null;
    signalCode: string | number | null;
    kill: (signal: NodeJS.Signals) => void;
  };
};

const STALL_INSPECTION_TIMEOUT_MS = 1000;

const inspectStalledProcess = async (pid: number, storeDirectory: string) => {
  const script = String.raw`
pid="$1"
store="$2"
pids="$pid"
pending="$pid"
while [[ -n "$pending" ]]; do
  next=""
  for parent in $pending; do
    children=$(pgrep -P "$parent" 2>/dev/null || true)
    [[ -z "$children" ]] || pids="$pids $children"
    next="$next $children"
  done
  pending="$next"
done
echo "Process state (pid ppid stat wchan command):"
ps -o pid=,ppid=,stat=,wchan:32=,command= -p "$(tr ' ' ',' <<<"$pids")" 2>&1 || true
echo "Open file descriptor counts:"
for process in $pids; do
  if [[ -d "/proc/$process/fd" ]]; then
    printf '%s ' "$process"
    find "/proc/$process/fd" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l
  else
    echo "$process unavailable"
  fi
done
echo "Newest install-store paths (at most 20):"
if [[ -d "$store" ]]; then
  find "$store" -mindepth 1 -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -20 || true
else
  echo "$store unavailable"
fi
`;
  const inspection = Bun.spawn({
    cmd: [
      "bash",
      "-c",
      script,
      "stall-inspection",
      String(pid),
      storeDirectory,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = Promise.all([
    new Response(inspection.stdout).text(),
    new Response(inspection.stderr).text(),
    inspection.exited,
  ]).then(([stdout, stderr]) => `${stdout}${stderr}`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completed,
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => {
          inspection.kill("SIGKILL");
          resolve(
            `Process inspection timed out after ${STALL_INSPECTION_TIMEOUT_MS} ms.\n`,
          );
        }, STALL_INSPECTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    void completed.catch(() => undefined);
  }
};

const spawnInstallAttempt = (
  command: readonly string[],
  spawn: NonNullable<LoggedInstallOptions["spawn"]>,
) => {
  const child = spawn(command);
  const completion = new AbortController();
  let cancelTimer: (() => void) | undefined;
  let sampling: Promise<void> | undefined;
  let inspection: Promise<void> | undefined;
  return {
    child,
    completion,
    get sampling() {
      return sampling;
    },
    setSampling: (probe: Promise<void> | undefined) => {
      sampling = probe;
    },
    setInspection: (capture: Promise<void>) => {
      inspection = capture;
    },
    setCancelTimer: (cancel: () => void) => {
      cancelTimer = cancel;
    },
    dispose: async () => {
      completion.abort();
      cancelTimer?.();
      await sampling;
      await inspection;
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
  };
};

export const runLoggedInstall = async ({
  command,
  logFile,
  budgetMs = installWarningBudgetMs(process.platform),
  stallMs = INSTALL_STALL_MS,
  restoreOutcome = "cold",
  storeKey = "uncached:filtered-install",
  progressRoots = [
    process.env["BUN_INSTALL_CACHE_DIR"] ??
      path.join(homedir(), ".bun/install/cache"),
    path.join(process.cwd(), "node_modules"),
  ],
  report = (message) => {
    process.stdout.write(message);
  },
  now = Date.now,
  record: write = (descriptor, chunk) => {
    writeSync(descriptor, chunk);
  },
  sampleStore = installStoreProgress,
  inspectProcess = inspectStalledProcess,
  scheduleInterval = (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    return () => {
      clearInterval(timer);
    };
  },
  spawn = (spawnCommand) =>
    Bun.spawn({
      cmd: [...spawnCommand],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
}: LoggedInstallOptions) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const descriptor = openSync(logFile, "w+");
  const started = now();
  const record = (chunk: string | Uint8Array) => {
    write(descriptor, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  };
  const summary = (message: string) => {
    record(message);
    report(message);
  };
  try {
    const runAttempt = async (
      attempt: number,
    ): Promise<InstallAttemptResult> => {
      const attemptStarted = now();
      const attemptScope = spawnInstallAttempt(command, spawn);
      const { child, completion } = attemptScope;
      try {
        const watchdog = createInstallWatchdog({
          budgetMs,
          stallMs,
          now,
          warn: () =>
            summary(
              `::warning title=install-budget::kind=infra class=${restoreOutcome === "cold" ? "install-cold-budget" : "install-budget"} ${telemetry()}\n`,
            ),
          kill: () => {
            const inspection = (async () => {
              let evidence: string;
              try {
                evidence = await inspectProcess(
                  child.pid,
                  progressRoots[0] ?? "",
                );
              } catch (error) {
                evidence = `Process inspection failed: ${String(error)}\n`;
              }
              summary(
                `::group::Stalled install process evidence\n${evidence}::endgroup::\n`,
              );
              child.kill("SIGKILL");
            })();
            attemptScope.setInspection(inspection);
          },
        });
        const telemetry = () =>
          `restore=${restoreOutcome} key=${storeKey} attempt=${attempt} install_ms=${now() - started} budget_ms=${budgetMs} stall_ms=${stallMs} max_progress_gap_ms=${watchdog.maximumGapMs()}`;
        summary(
          `Install started; warning budget ${budgetMs} ms; ${telemetry()}; log ${logFile}\n`,
        );
        let previousStore: string | undefined;
        let lastProbe = attemptStarted;
        const probeStore = async () => {
          try {
            const store = await sampleStore(
              progressRoots,
              () => !completion.signal.aborted,
            );
            if (completion.signal.aborted) {
              return;
            }
            if (
              (previousStore !== undefined &&
                store.signature !== previousStore) ||
              (store.newest >= attemptStarted && previousStore === undefined)
            ) {
              watchdog.progress();
            }
            previousStore = store.signature;
            watchdog.tick();
          } catch (error) {
            // An unreadable store cannot prove a stall. Keep the job deadline and
            // surface the failed probe rather than killing a progressing install.
            if (!completion.signal.aborted) {
              summary(
                `::warning title=install-progress-probe::${String(error)}\n`,
              );
            }
          } finally {
            attemptScope.setSampling(undefined);
          }
        };
        attemptScope.setCancelTimer(
          scheduleInterval(
            () => {
              if (
                completion.signal.aborted ||
                attemptScope.sampling !== undefined
              ) {
                return;
              }
              watchdog.finish();
              const probeInterval = Math.min(10_000, stallMs / 2);
              if (watchdog.idleMs() < probeInterval) {
                watchdog.tick();
                return;
              }
              if (now() - lastProbe < probeInterval) {
                return;
              }
              lastProbe = now();
              attemptScope.setSampling(probeStore());
            },
            Math.min(1000, stallMs / 2),
          ),
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
        return { exitCode, stalled: watchdog.wasStalled() };
      } finally {
        await attemptScope.dispose();
      }
    };
    const result = await retryStalledInstall(runAttempt);
    if (result.retried && !result.stalled && result.exitCode === 0) {
      summary(
        `::warning title=install-stall-retried::kind=infra class=install-stall-retried restore=${restoreOutcome} key=${storeKey} install_ms=${now() - started}\n`,
      );
    } else if (result.stalled) {
      summary(
        `::error title=install-stall::kind=infra class=install-stall restore=${restoreOutcome} key=${storeKey} install_ms=${now() - started}\n`,
      );
    }
    return result.exitCode;
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
