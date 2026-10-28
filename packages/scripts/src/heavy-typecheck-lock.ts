import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { childExitStatus } from "./child-exit-status";

export const HEAVY_TYPECHECK_LOCK_WAIT_SECONDS = 1800;
const LOCK_TIMEOUT_EXIT_CODE = 75;
const LOCK_ACQUIRED_SCRIPT =
  'printf "heavy-typecheck-lock: acquired host lock\\n"; export STELLA_HEAVY_TYPECHECK_LOCK_HELD=1; exec "$@"';

type LockPlatform = "darwin" | "linux" | "other";

const currentLockPlatform = (): LockPlatform => {
  if (process.platform === "darwin") {
    return "darwin";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  return "other";
};

type BuildHeavyTypecheckLockArgvOptions = {
  command: readonly string[];
  lockPath: string;
  platform: LockPlatform;
  toolExists: (filename: string) => boolean;
  waitSeconds?: number;
};

export const buildHeavyTypecheckLockArgv = ({
  command,
  lockPath,
  platform,
  toolExists,
  waitSeconds = HEAVY_TYPECHECK_LOCK_WAIT_SECONDS,
}: BuildHeavyTypecheckLockArgvOptions): string[] => {
  const guardedCommand = [
    "/bin/sh",
    "-c",
    LOCK_ACQUIRED_SCRIPT,
    "heavy-typecheck-lock",
    ...command,
  ];
  if (platform === "darwin" && toolExists("/usr/bin/lockf")) {
    return [
      "/usr/bin/lockf",
      "-k",
      "-t",
      String(waitSeconds),
      lockPath,
      ...guardedCommand,
    ];
  }
  if (platform === "linux" && toolExists("/usr/bin/flock")) {
    return [
      "/usr/bin/flock",
      "-E",
      String(LOCK_TIMEOUT_EXIT_CODE),
      "-w",
      String(waitSeconds),
      lockPath,
      ...guardedCommand,
    ];
  }
  return [...command];
};

export type HeavyTypecheckLockResult =
  | { type: "completed"; exitCode: number }
  | { type: "wait-timeout"; waitSeconds: number };

type RunHeavyTypecheckWithLockOptions = {
  command: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  lockPath?: string;
  platform?: LockPlatform;
  toolExists?: (filename: string) => boolean;
  waitSeconds?: number;
};

export const runHeavyTypecheckWithLock = async ({
  command,
  cwd,
  env,
  lockPath = path.join(
    os.homedir(),
    ".cache",
    "stella",
    "heavy-typecheck.lock",
  ),
  platform = currentLockPlatform(),
  toolExists = existsSync,
  waitSeconds = HEAVY_TYPECHECK_LOCK_WAIT_SECONDS,
}: RunHeavyTypecheckWithLockOptions): Promise<HeavyTypecheckLockResult> => {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const argv = buildHeavyTypecheckLockArgv({
    command,
    lockPath,
    platform,
    toolExists,
    waitSeconds,
  });
  const usesLock = argv[0] !== command[0];
  if (usesLock) {
    process.stdout.write(
      `heavy-typecheck-lock: waiting up to ${String(waitSeconds)} s for host lock\n`,
    );
  }
  const child = Bun.spawn(argv, {
    ...(cwd === undefined ? {} : { cwd }),
    env: env ?? process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = childExitStatus(await child.exited);
  if (usesLock && exitCode === LOCK_TIMEOUT_EXIT_CODE) {
    return { type: "wait-timeout", waitSeconds };
  }
  return { type: "completed", exitCode };
};
