import { Result, TaggedError } from "better-result";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export class SkillRunnerIsolationError extends TaggedError(
  "SkillRunnerIsolationError",
)<{ message: string; cause?: unknown }> {}

/**
 * The variables AWS hands an execution environment its credentials in. The
 * image's entrypoint removes them before the runtime starts, so no process a
 * command could read holds them.
 */
const CREDENTIAL_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
] as const;

/** Rounds of killing what a command left before the runner gives up. */
const SWEEP_ROUNDS = 20;
const SWEEP_PAUSE_MS = 20;

/** One file of a process: its text, or why there is none. */
type ProcessFile =
  { kind: "read"; text: string } | { kind: "gone" } | { kind: "unreadable" };

const readProcessFile = async (
  procRoot: string,
  pid: number,
  file: string,
): Promise<ProcessFile> => {
  const read = await Result.tryPromise({
    try: async () =>
      await readFile(path.join(procRoot, String(pid), file), "utf-8"),
    catch: (cause) => cause,
  });
  if (read.isOk()) {
    return { kind: "read", text: read.value };
  }
  const cause = read.error;
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
    ? { kind: "gone" }
    : { kind: "unreadable" };
};

const processIds = async (
  procRoot: string,
): Promise<Result<number[], SkillRunnerIsolationError>> => {
  const entries = await Result.tryPromise({
    try: async () => await readdir(procRoot),
    catch: (cause) =>
      new SkillRunnerIsolationError({
        message: "The process table could not be read",
        cause,
      }),
  });
  return entries.map((names) =>
    names.filter((name) => /^\d+$/u.test(name)).map(Number),
  );
};

const holdsCredentials = (environ: string) =>
  environ
    .split("\0")
    .some((entry) =>
      CREDENTIAL_KEYS.some((key) => entry.startsWith(`${key}=`)),
    );

/**
 * Refuse to run when any process this runner can read holds AWS credentials,
 * its own included. A command runs as the runner's user and sees the same
 * process table, so an environment allowlist alone would not keep them from
 * it. A process whose environment the runner cannot read, the command cannot
 * read either.
 */
export const checkCredentialIsolation = async (
  procRoot: string,
): Promise<Result<void, SkillRunnerIsolationError>> => {
  const pids = await processIds(procRoot);
  if (pids.isErr()) {
    return Result.err(pids.error);
  }
  const exposed: number[] = [];
  for (const pid of pids.value) {
    const environ = await readProcessFile(procRoot, pid, "environ");
    if (environ.kind === "read" && holdsCredentials(environ.text)) {
      exposed.push(pid);
    }
  }
  if (exposed.length > 0) {
    return Result.err(
      new SkillRunnerIsolationError({
        message: `AWS credentials are readable in processes ${exposed.join(", ")}`,
      }),
    );
  }
  return Result.ok(undefined);
};

/** The processes alive now: the baseline a sweep leaves alone. */
export const liveProcessIds = async (
  procRoot: string,
): Promise<Result<ReadonlySet<number>, SkillRunnerIsolationError>> =>
  (await processIds(procRoot)).map((pids) => new Set(pids));

/**
 * Whether a process can still act. A zombie has exited and only waits to be
 * reaped; a process whose state cannot be read counts as running, so the
 * sweep tries to end it and fails the run when it cannot.
 */
const canStillAct = async (procRoot: string, pid: number) => {
  const stat = await readProcessFile(procRoot, pid, "stat");
  if (stat.kind !== "read") {
    return stat.kind === "unreadable";
  }
  // `pid (comm) S ...`: the state follows the last parenthesis, which also
  // ends a command name that itself contains one.
  const state = stat.text.slice(stat.text.lastIndexOf(")") + 2).charAt(0);
  return state !== "Z";
};

/**
 * Kill every process that was not alive before the command, until none is
 * left. A command may leave its process group (`setsid`) to outlive it; the
 * process table still names everything it started.
 */
export const sweepNewProcesses = async ({
  procRoot,
  baseline,
  kill,
}: {
  procRoot: string;
  baseline: ReadonlySet<number>;
  kill: (pid: number) => boolean;
}): Promise<Result<void, SkillRunnerIsolationError>> => {
  for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
    const pids = await processIds(procRoot);
    if (pids.isErr()) {
      return Result.err(pids.error);
    }
    const left: number[] = [];
    for (const pid of pids.value) {
      if (
        !baseline.has(pid) &&
        pid !== process.pid &&
        (await canStillAct(procRoot, pid))
      ) {
        left.push(pid);
      }
    }
    if (left.length === 0) {
      return Result.ok(undefined);
    }
    for (const pid of left) {
      kill(pid);
    }
    await sleep(SWEEP_PAUSE_MS);
  }
  return Result.err(
    new SkillRunnerIsolationError({
      message: "Processes the command started are still running",
    }),
  );
};
