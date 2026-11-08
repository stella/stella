import { Result, TaggedError } from "better-result";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, readdirSync, readFileSync } from "node:fs";
import * as v from "valibot";

/**
 * A harness CLI and every process it starts, ended together.
 *
 * On macOS and Linux the CLI starts a session of its own (`setsid`) and
 * leads its process group. Ending the tree signals that group and every
 * other process still in the session: a stop, an interrupt, the turn's end
 * or the holder's own exit ends the shells, scripts and browsers an agent
 * started, not only the CLI. The session also holds what left the group but
 * not the session: Codex runs each command in a process group of its own,
 * and a background job outlives the shell that started it. A process that
 * starts a session of its own (`setsid`, a daemon detaching from its
 * terminal) is not reached.
 *
 * A watcher in the CLI's group holds a pipe whose other end only the holder
 * has. When the holder goes away without ending the tree (a crash, a
 * SIGKILL), the pipe closes and the watcher ends the CLI's group itself: the
 * group, not the rest of the session, which a shell cannot list on macOS.
 *
 * Windows has no process groups or sessions to signal, and Bun exposes no
 * job object. There the tree is ended with `taskkill /T /F` while the CLI
 * still runs, which reaches every process whose chain of parents back to the
 * CLI is intact at that moment. A process whose parent already exited, and
 * anything left behind once the CLI exited on its own, is not reached.
 *
 * The group watcher follows the one t3code (MIT,
 * https://github.com/pingdotgg/t3code) wraps its Claude Code process in
 * (`spawnClaudeProcessGroup`), reimplemented here.
 */

/**
 * Run as `/bin/sh -c <script> stella-harness <grace seconds> <command...>`:
 * starts the watcher in the background, then becomes the CLI (same pid, so
 * the group's id is the CLI's pid). The watcher blocks on fd 3 until the
 * holder's end closes; it then ignores SIGTERM itself, sends it to its group
 * (`-$$`: the group the CLI leads, never the holder's), and sends SIGKILL
 * once the grace passes. Until then it ends with the group like any member.
 * The CLI does not inherit fd 3, so only the holder keeps the pipe open.
 */
const GROUP_WATCH_SCRIPT = [
  'grace="$1"',
  "shift",
  `{ read -r _ <&3; trap '' TERM; kill -TERM -$$; /bin/sleep "$grace"; kill -KILL -$$; } </dev/null >/dev/null 2>&1 &`,
  'exec "$@" 3<&-',
].join("\n");

/** The first wait between checks of an ending tree; it doubles up to the cap. */
const GONE_POLL_MS = 20;
const GONE_POLL_MAX_MS = 250;

type HarnessChild = Bun.Subprocess<"pipe", "pipe", "ignore">;

export type HarnessProcessTree = {
  /** The CLI: its stdio is the harness's protocol. */
  readonly child: HarnessChild;
  /**
   * End every process of the tree: SIGTERM, then SIGKILL once `terminateMs`
   * passes with one still running. Settles once none is left, or once the
   * wait after SIGKILL ran out too. Every call returns the same ending.
   */
  end: () => Promise<void>;
};

type SpawnHarnessProcessTreeOptions = {
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** How long the tree gets to exit on SIGTERM before SIGKILL. */
  terminateMs: number;
};

/** Why a harness process could not be started. */
export class HarnessSpawnError extends TaggedError("HarnessSpawnError")<{
  reason: "not_found" | "refused";
  message: string;
  cause?: unknown;
}> {}

/**
 * The executable as `Bun.spawn` would find it with this environment, so a
 * missing CLI is refused when it is started, not later by the shell that
 * would run it.
 */
const resolveExecutable = (
  executable: string | undefined,
  { cwd, env }: { cwd: string; env: Readonly<Record<string, string>> },
): Result<string, HarnessSpawnError> => {
  const path = env["PATH"];
  const resolved =
    executable === undefined || executable === ""
      ? null
      : Bun.which(
          executable,
          path === undefined ? { cwd } : { cwd, PATH: path },
        );
  return resolved === null
    ? Result.err(
        new HarnessSpawnError({
          reason: "not_found",
          message: "Executable not found",
        }),
      )
    : Result.ok(resolved);
};

/** A spawn the operating system refused. */
const refused = (cause: unknown) =>
  new HarnessSpawnError({
    reason: "refused",
    message: "The harness process could not be started.",
    cause,
  });

/** Waits until `alive` says no, or `ms` passes; true when it said no. */
const goneWithin = async (
  alive: () => boolean | Promise<boolean>,
  ms: number,
) => {
  const deadline = performance.now() + ms;
  let pause = GONE_POLL_MS;
  while (await alive()) {
    const left = deadline - performance.now();
    if (left <= 0) {
      return false;
    }
    await Bun.sleep(Math.min(pause, left));
    pause = Math.min(pause * 2, GONE_POLL_MAX_MS);
  }
  return true;
};

const once = (work: () => Promise<void>) => {
  const started: { ending: Promise<void> | null } = { ending: null };
  return async () => {
    started.ending ??= work();
    await started.ending;
  };
};

/**
 * Signal `target` (a pid, or a group as its negative). Ids at or below 1
 * would reach this process's own group (0) or every process the user owns
 * (-1), so only a spawned process's id is accepted. Whether the signal was
 * delivered; signal 0 delivers nothing and only asks whether `target` exists.
 */
const signal = (target: number, sent: NodeJS.Signals | 0) => {
  if (!Number.isSafeInteger(target) || Math.abs(target) <= 1) {
    return false;
  }
  // A process that already exited is the outcome being asked for.
  return Result.isOk(Result.try(() => process.kill(target, sent)));
};

/**
 * The live processes of a session, or that they could not be listed: then
 * only the CLI's group can be reached.
 */
type SessionListing =
  { type: "listed"; pids: readonly number[] } | { type: "unlisted" };

const LINUX_STAT_FIELDS = { state: 0, session: 3 } as const;

/** A whole decimal id, digits only: no sign, space or other spelling. */
const ProcessIdSchema = v.pipe(
  v.string(),
  v.digits(),
  v.toNumber(),
  v.safeInteger(),
  v.minValue(2),
);

/**
 * A process or group id as `/proc` or `ps` writes it, or `null` for text that
 * names none (`/proc/self`, a header) or one at or below 1, which no spawned
 * process has.
 */
const processIdOf = (text: string | undefined): number | null => {
  const parsed = v.safeParse(ProcessIdSchema, text);
  return parsed.success ? parsed.output : null;
};

/**
 * The session of `pid` from `/proc`, or `null` once it exited (a zombie
 * included) or cannot be read.
 */
const linuxSessionOf = (pid: number) => {
  const stat = Result.try(() =>
    readFileSync(`/proc/${String(pid)}/stat`, "latin1"),
  );
  if (Result.isError(stat)) {
    return null;
  }
  // `pid (comm) state ppid pgrp session …`; the name can hold spaces and `)`.
  const fields = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ");
  const state = fields[LINUX_STAT_FIELDS.state];
  return state === "Z" || state === "X"
    ? null
    : processIdOf(fields[LINUX_STAT_FIELDS.session]);
};

const linuxSessionMembers = (sessionId: number): SessionListing => {
  const listed = Result.try(() => readdirSync("/proc"));
  if (Result.isError(listed)) {
    return { type: "unlisted" };
  }
  return {
    type: "listed",
    pids: listed.value.flatMap((name) => {
      const pid = processIdOf(name);
      return pid !== null && linuxSessionOf(pid) === sessionId ? [pid] : [];
    }),
  };
};

/** `getsid(2)`: macOS's `ps` does not show a process's session. */
const darwinGetsid = (() => {
  const loaded: { getsid?: ((pid: number) => number) | null } = {};
  return () => {
    if (loaded.getsid === undefined) {
      const opened = Result.try(() =>
        dlopen("/usr/lib/libSystem.B.dylib", {
          getsid: { args: [FFIType.i32], returns: FFIType.i32 },
        }),
      );
      loaded.getsid = Result.isOk(opened)
        ? (pid) => opened.value.symbols.getsid(pid)
        : null;
    }
    return loaded.getsid;
  };
})();

/**
 * The live (not yet exited) processes of `sessionId`, from `ps`. Without
 * `getsid` it falls back to the CLI's own group, whose id is the session's.
 */
const darwinSessionMembers = async (
  sessionId: number,
): Promise<SessionListing> => {
  const getsid = darwinGetsid();
  const listing = Result.try(() =>
    Bun.spawn(["/bin/ps", "-A", "-o", "pid=,pgid=,stat="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }),
  );
  if (Result.isError(listing)) {
    return { type: "unlisted" };
  }
  const text = await new Response(listing.value.stdout).text();
  if ((await listing.value.exited) !== 0) {
    return { type: "unlisted" };
  }
  const members: number[] = [];
  for (const line of text.split("\n")) {
    const [pidText, groupText, state] = line.trim().split(/\s+/u);
    const pid = processIdOf(pidText);
    if (
      pid !== null &&
      state !== undefined &&
      !state.startsWith("Z") &&
      (getsid === null
        ? processIdOf(groupText) === sessionId
        : getsid(pid) === sessionId)
    ) {
      members.push(pid);
    }
  }
  return { type: "listed", pids: members };
};

/** The live processes of session `sessionId`. */
const sessionMembers = async (sessionId: number): Promise<SessionListing> =>
  process.platform === "linux"
    ? linuxSessionMembers(sessionId)
    : await darwinSessionMembers(sessionId);

/** Whether `pid` is still a live process of session `sessionId`. */
const inSession = (pid: number, sessionId: number) =>
  process.platform === "linux"
    ? linuxSessionOf(pid) === sessionId
    : (darwinGetsid()?.(pid) ?? sessionId) === sessionId;

const spawnSession = ({
  command,
  cwd,
  env,
  terminateMs,
}: SpawnHarnessProcessTreeOptions): Result<
  HarnessProcessTree,
  HarnessSpawnError
> => {
  const [executable, ...args] = command;
  const resolved = resolveExecutable(executable, { cwd, env });
  if (Result.isError(resolved)) {
    return resolved;
  }
  const graceSeconds = Math.max(1, Math.ceil(terminateMs / 1000));
  const started = Result.try(() =>
    Bun.spawn(
      [
        "/bin/sh",
        "-c",
        GROUP_WATCH_SCRIPT,
        "stella-harness",
        String(graceSeconds),
        resolved.value,
        ...args,
      ],
      {
        cwd,
        env: { ...env },
        // `setsid`: the CLI leads a new session and process group.
        detached: true,
        // Harness logs may carry account details, so stderr is dropped. Fd 3
        // is the watcher's pipe.
        stdio: ["pipe", "pipe", "ignore", "pipe"],
      },
    ),
  );
  if (Result.isError(started)) {
    return Result.err(refused(started.error.cause));
  }
  const spawned = started.value;
  const child: HarnessChild = spawned;
  const watch = spawned.stdio[3];
  // The session's id and the group's are the CLI's pid.
  const leader = child.pid;
  const alive = async () => {
    const members = await sessionMembers(leader);
    // Unlisted, the group answers for itself; a zombie member keeps
    // answering, which errs towards SIGKILL.
    return members.type === "listed"
      ? members.pids.length > 0
      : signal(-leader, 0);
  };
  const signalTree = async (sent: NodeJS.Signals) => {
    // The group in one call, so a member that forks meanwhile is not missed.
    signal(-leader, sent);
    const members = await sessionMembers(leader);
    if (members.type === "unlisted") {
      return;
    }
    for (const pid of members.pids) {
      // Checked again right before: a member that exited since the listing
      // may have left its pid to a process outside the session.
      if (pid !== process.pid && inSession(pid, leader)) {
        signal(pid, sent);
      }
    }
  };
  const end = once(async () => {
    await signalTree("SIGTERM");
    if (!(await goneWithin(alive, terminateMs))) {
      await signalTree("SIGKILL");
      await goneWithin(alive, terminateMs);
    }
    // The watcher went with the group: closing its pipe now cannot make it
    // signal a group id that was reused.
    if (typeof watch === "number") {
      // A pipe that is closed already needs nothing more.
      Result.try(() => {
        closeSync(watch);
      }).unwrapOr(undefined);
    }
  });
  return Result.ok({ child, end });
};

const spawnWindowsTree = ({
  command,
  cwd,
  env,
  terminateMs,
}: SpawnHarnessProcessTreeOptions): Result<
  HarnessProcessTree,
  HarnessSpawnError
> => {
  const started = Result.try(() =>
    Bun.spawn([...command], {
      cwd,
      env: { ...env },
      stdin: "pipe",
      stdout: "pipe",
      // Harness logs may carry account details.
      stderr: "ignore",
      windowsHide: true,
    }),
  );
  if (Result.isError(started)) {
    return Result.err(refused(started.error.cause));
  }
  const child = started.value;
  const running = () => child.exitCode === null && child.signalCode === null;
  const end = once(async () => {
    if (!running()) {
      // Its tree can no longer be found from it.
      return;
    }
    const tree = Result.try(() =>
      Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      }),
    );
    if (Result.isOk(tree)) {
      await goneWithin(() => tree.value.exitCode === null, terminateMs);
    }
    // The CLI itself, whatever taskkill managed.
    child.kill("SIGKILL");
    await goneWithin(running, terminateMs);
  });
  return Result.ok({ child, end });
};

/** Start `command` as the root of a tree that is ended as one. */
export const spawnHarnessProcessTree = (
  options: SpawnHarnessProcessTreeOptions,
): Result<HarnessProcessTree, HarnessSpawnError> =>
  process.platform === "win32"
    ? spawnWindowsTree(options)
    : spawnSession(options);
