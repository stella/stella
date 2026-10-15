import { panic, Result, TaggedError } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const FLAKE_GATE_TRIAL_ENV = "FLAKE_GATE_TRIAL";
export type FlakeCleanup =
  | { type: "linux-proc-token"; note: "cleanup: Linux /proc trial ownership" }
  | { type: "best-effort"; platform: string; note: "cleanup: best-effort" };

export const cleanupCapability = (platform = process.platform): FlakeCleanup =>
  platform === "linux"
    ? { type: "linux-proc-token", note: "cleanup: Linux /proc trial ownership" }
    : { type: "best-effort", platform, note: "cleanup: best-effort" };

class FlakeProcessError extends TaggedError("FlakeProcessError")<{
  message: string;
  cause?: unknown;
}> {}

const signalOwnedProcess = (pid: number, signal: NodeJS.Signals) => {
  const signalled = Result.try({
    try: () => process.kill(pid, signal),
    catch: (cause) =>
      new FlakeProcessError({
        message: `Cannot send ${signal} to owned process ${pid}`,
        cause,
      }),
  });
  if (signalled.isOk()) {
    return;
  }
  const cause = signalled.error.cause;
  if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
    return;
  }
  throw signalled.error;
};

/** Freeze before discovery so a detached grandchild cannot fork past the timeout snapshot. */
const terminateFlakeProcessTree = (rootPid: number) => {
  if (rootPid <= 1 || rootPid === process.pid) {
    panic("Invalid flake process root");
  }
  const owned = new Set([rootPid]);
  const stopped = Result.try(() => {
    signalOwnedProcess(rootPid, "SIGSTOP");
    for (;;) {
      const snapshot = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], {
        timeout: 1000,
      });
      if (!snapshot.success) {
        throw new FlakeProcessError({
          message: "Cannot inspect flake runner descendants",
        });
      }
      let discovered = 0;
      for (const line of snapshot.stdout.toString().trim().split("\n")) {
        const [pidText, parentText] = line.trim().split(/\s+/u);
        const pid = Number(pidText);
        const parent = Number(parentText);
        if (
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          !owned.has(parent) ||
          owned.has(pid)
        ) {
          continue;
        }
        owned.add(pid);
        signalOwnedProcess(pid, "SIGSTOP");
        discovered += 1;
      }
      if (discovered === 0) {
        break;
      }
    }
  });
  // Always release stopped processes, including when inspection fails.
  const failures: string[] = [];
  for (const pid of [...owned].toReversed()) {
    const killed = Result.try(() => signalOwnedProcess(pid, "SIGKILL"));
    if (killed.isErr()) {
      failures.push(killed.error.message);
    }
  }
  if (stopped.isErr()) {
    failures.push(stopped.error.message);
  }
  if (failures.length > 0) {
    throw new FlakeProcessError({ message: failures.join("; ") });
  }
};

type MarkedProcessOptions = { procRoot: string; token: string };
const markedProcessIds = ({ procRoot, token }: MarkedProcessOptions) => {
  const marker = `${FLAKE_GATE_TRIAL_ENV}=${token}`;
  const pids: number[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) {
      continue;
    }
    const environ = Result.try(() =>
      readFileSync(path.join(procRoot, entry, "environ")),
    );
    if (environ.isOk()) {
      // Exact NUL-delimited entries avoid matching another variable's value.
      if (environ.value.toString().split("\0").includes(marker)) {
        pids.push(pid);
      }
      continue;
    }
    const cause = environ.error.cause;
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String(cause.code))
    ) {
      continue;
    }
    throw new FlakeProcessError({
      message: `Cannot inspect trial ownership for process ${pid}`,
      cause: environ.error,
    });
  }
  return pids;
};

const processHasExited = (procRoot: string, pid: number) => {
  const status = Result.try(() =>
    readFileSync(path.join(procRoot, String(pid), "status"), "utf-8"),
  );
  if (status.isOk()) {
    return /^State:\s+[ZX]\b/mu.test(status.value);
  }
  const cause = status.error.cause;
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ESRCH")
  ) {
    return true;
  }
  throw new FlakeProcessError({
    message: `Cannot confirm exit for owned process ${pid}`,
    cause: status.error,
  });
};

type CleanupFlakeTrialOptions = {
  rootPid: number;
  token: string;
  platform?: NodeJS.Platform;
  procRoot?: string;
  signal?: typeof signalOwnedProcess;
};

/** Environment ownership survives setsid and reparenting; test descendants inherit it. */
export const cleanupFlakeTrial = async ({
  rootPid,
  token,
  platform = process.platform,
  procRoot = "/proc",
  signal = signalOwnedProcess,
}: CleanupFlakeTrialOptions): Promise<FlakeCleanup> => {
  if (
    !token ||
    token.includes("\0") ||
    rootPid <= 1 ||
    rootPid === process.pid
  ) {
    panic("Invalid flake trial ownership");
  }
  if (platform !== "linux") {
    terminateFlakeProcessTree(rootPid);
    return cleanupCapability(platform);
  }
  const maxPasses = 20;
  const observed = new Set<number>();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const pids = markedProcessIds({ procRoot, token });
    if (
      pids.length === 0 &&
      [...observed].every((pid) => processHasExited(procRoot, pid))
    ) {
      return cleanupCapability(platform);
    }
    for (const pid of pids) {
      observed.add(pid);
    }
    const stopped = Result.try(() => {
      for (const pid of pids) {
        signal(pid, "SIGSTOP");
      }
    });
    const failures: string[] = [];
    // Attempt every kill even when freezing or another kill failed.
    for (const pid of pids) {
      const killed = Result.try(() => signal(pid, "SIGKILL"));
      if (killed.isErr()) {
        failures.push(killed.error.message);
      }
    }
    if (stopped.isErr()) {
      failures.push(stopped.error.message);
    }
    if (failures.length > 0) {
      throw new FlakeProcessError({ message: failures.join("; ") });
    }
    // Yield for exit/reparenting without relying on a fixed wall-clock delay.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new FlakeProcessError({
    message: "Trial-owned processes remain after bounded Linux cleanup",
  });
};
