import { panic, Result, TaggedError } from "better-result";

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
export const terminateFlakeProcessTree = (rootPid: number) => {
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
