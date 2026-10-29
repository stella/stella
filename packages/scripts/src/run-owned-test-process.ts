import { childExitStatus } from "./child-exit-status";
import { testInvocationMemoryLimit } from "./process-memory";
import { attachTestProcessShutdown } from "./process-shutdown";
import { spawnTestProcess } from "./process-spawn";

type RunOwnedTestProcessOptions = {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout: "inherit" | "ignore";
  stderr: "inherit" | "ignore";
};

/** Keep every descendant owned through completion, cancellation and runner exit. */
export const runOwnedTestProcess = async ({
  command,
  cwd,
  env,
  stdout,
  stderr,
}: RunOwnedTestProcessOptions): Promise<number> => {
  const onWarning = (message: string) => {
    process.stderr.write(`${message}\n`);
  };
  const { child, windowsProcesses } = spawnTestProcess({
    command,
    limitBytes: testInvocationMemoryLimit(env ?? process.env),
    options: {
      cwd,
      env,
      stdin: "inherit",
      stdout,
      stderr,
      detached: process.platform !== "win32",
    },
    onWarning,
  });
  const shutdown = attachTestProcessShutdown({
    child,
    windowsProcesses,
    termination: process.platform === "win32" ? "process" : "group",
    onWarning,
  });
  try {
    await child.exited;
    const cancelled = shutdown.exitCode();
    if (cancelled !== undefined) {
      process.exit(cancelled);
    }
    return childExitStatus(child);
  } finally {
    shutdown.dispose();
  }
};
