// The cache wrapper restores the install store before dependencies exist, so
// this module imports only runtime built-ins.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

type KillTreeOptions = {
  onError: (error: unknown) => void;
};

const processGroupExists = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
};

const processGroupIsRunning = (pid: number) => {
  if (!processGroupExists(pid)) {
    return false;
  }
  const statuses = spawnSync("ps", ["-o", "stat=", "-g", String(pid)], {
    encoding: "utf-8",
  });
  if (statuses.status !== 0) {
    return true;
  }
  return statuses.stdout
    .split("\n")
    .some((status) => status.trim() !== "" && !status.trim().startsWith("Z"));
};

export const killTree = async (
  child: ChildProcess,
  { onError }: KillTreeOptions,
) => {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
      killer.once("error", (error) => {
        onError(error);
        child.kill("SIGKILL");
        resolve();
      });
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    while (processGroupIsRunning(child.pid)) {
      await Bun.sleep(10);
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      onError(error);
    }
  }
};
