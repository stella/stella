import { Result, TaggedError } from "better-result";

const SHUTDOWN_SIGNALS = [
  { signal: "SIGINT", number: 2 },
  { signal: "SIGTERM", number: 15 },
  { signal: "SIGHUP", number: 1 },
] as const;
const STOP_GRACE_MS = 1000;

class TestProcessSignalError extends TaggedError("TestProcessSignalError")<{
  message: string;
  cause: unknown;
}> {}

type AttachTestProcessShutdownOptions = {
  child: Pick<Bun.Subprocess, "pid" | "kill">;
  termination: "process" | "group";
  onWarning: (message: string) => void;
};

/** Own this child's process tree until its pipes and exit have settled. */
export const attachTestProcessShutdown = ({
  child,
  termination,
  onWarning,
}: AttachTestProcessShutdownOptions) => {
  let exitCode: number | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  const signalChild = (signal: NodeJS.Signals) => {
    const signalled = Result.try({
      try: () => {
        if (termination === "group") {
          process.kill(-child.pid, signal);
          return Result.ok(undefined);
        }
        if (process.platform === "win32") {
          // Exit listeners cannot await a subprocess; finish tree cleanup before
          // the runner exits, including workers absent from the latest sample.
          const result = Bun.spawnSync(
            [
              "taskkill.exe",
              "/PID",
              String(child.pid),
              "/T",
              ...(signal === "SIGKILL" ? ["/F"] : []),
            ],
            { timeout: 5000, stdout: "ignore", stderr: "pipe" },
          );
          if (!result.success) {
            // taskkill also fails when the tree has already exited. Probe the
            // root so an ordinary reap does not become a cleanup warning.
            process.kill(child.pid, 0);
            return Result.err(
              new TestProcessSignalError({
                message: result.stderr.toString().trim(),
                cause: result.exitCode,
              }),
            );
          }
          return Result.ok(undefined);
        }
        child.kill(signal);
        return Result.ok(undefined);
      },
      catch: (cause) =>
        new TestProcessSignalError({ message: String(cause), cause }),
    }).andThen((result) => result);
    if (
      signalled.isErr() &&
      !(
        signalled.error.cause instanceof Error &&
        "code" in signalled.error.cause &&
        signalled.error.cause.code === "ESRCH"
      )
    ) {
      onWarning(
        `Could not send ${signal} to test process ${child.pid}: ${signalled.error.message}`,
      );
    }
  };
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    signalChild("SIGKILL");
  };
  const handlers = SHUTDOWN_SIGNALS.map(({ signal, number }) => {
    const handler = () => {
      if (exitCode !== undefined) {
        cleanup();
        process.exit(exitCode);
      }
      exitCode = 128 + number;
      signalChild(signal);
      escalation = setTimeout(() => {
        cleanup();
        process.exit(exitCode);
      }, STOP_GRACE_MS);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  process.on("exit", cleanup);
  return {
    exitCode: () => exitCode,
    dispose: () => {
      cleanup();
      clearTimeout(escalation);
      process.off("exit", cleanup);
      for (const { signal, handler } of handlers) {
        process.off(signal, handler);
      }
    },
  };
};
