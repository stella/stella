import { Result } from "better-result";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import * as v from "valibot";

/**
 * Starting the stella browser: its profile folder, the flags it runs with,
 * the environment it gets, and ending a browser a dead holder left running
 * on the same profile. The holder owns the process and its pipe.
 */

/** The browser's folders, under `<app data>/browser/<member key>`. */
export type BrowserProfile = {
  /** `<member key>`: the profile's own folder, private to this user. */
  memberDir: string;
  /** Chrome's user data folder. */
  profileDir: string;
  /** Which holder started which browser, for the next holder to check. */
  instanceFile: string;
};

const INSTANCE_FILE = "instance.json";
const PROFILE_FOLDER = "profile";

/** Whether a folder is the user's alone: not a symlink, mode 0700 or less. */
const NOT_PRIVATE =
  "The stella browser's profile folder is not private to this user.";

/**
 * Creates a folder 0700 when it is missing, then holds it to being the
 * user's alone: a directory, not a symlink, owned by this user, with no
 * permission for the group or others. A folder that cannot be read for
 * that (no access, an I/O error) is refused like one that fails it.
 */
const privateFolder = (dir: string): Result<void, { message: string }> => {
  // Already there is fine; the check below decides.
  const made = Result.try(() => mkdirSync(dir, { mode: 0o700 }));
  const stat = Result.try(() => lstatSync(dir, { throwIfNoEntry: false }));
  if (Result.isError(stat) || stat.value === undefined) {
    return Result.err({
      message: Result.isError(made)
        ? "The stella browser's profile folder could not be created."
        : NOT_PRIVATE,
    });
  }
  const { value } = stat;
  // The low six mode bits are the group's and others' permissions.
  return value.isDirectory() &&
    !value.isSymbolicLink() &&
    value.uid === process.getuid?.() &&
    value.mode % 0o100 === 0
    ? Result.ok(undefined)
    : Result.err({ message: NOT_PRIVATE });
};

/**
 * The member's profile under `root`, each folder created private or
 * checked to be: owned by this user, mode 0700, not a symlink.
 */
export const prepareProfile = (
  root: string,
  memberKey: string,
): Result<BrowserProfile, { message: string }> => {
  const memberDir = path.join(root, memberKey);
  const profileDir = path.join(memberDir, PROFILE_FOLDER);
  for (const dir of [root, memberDir, profileDir]) {
    const checked = privateFolder(dir);
    if (Result.isError(checked)) {
      return checked;
    }
  }
  return Result.ok({
    instanceFile: path.join(memberDir, INSTANCE_FILE),
    memberDir,
    profileDir,
  });
};

/**
 * The browser's flags: its own profile, the protocol over the inherited
 * pipe, and no first-run or default-browser prompts. Nothing that marks
 * the browser as automated, hides that it is, or weakens its sandbox or
 * certificate checks: the fixture site's two flags come only from the test
 * hooks, which release builds do not have.
 */
export const browserArguments = ({
  profileDir,
  testArgs,
}: {
  profileDir: string;
  testArgs: readonly string[];
}): string[] => [
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  ...testArgs,
  // The first window opens blank, not on the new tab page.
  "about:blank",
];

/** Variables the browser gets from the holder's environment; nothing of stella's. */
const PASSED_VARIABLES = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // Linux desktops: where its window goes.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
]);

/** The environment the browser starts with: the member's, minimal. */
export const browserEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value !== undefined &&
      (PASSED_VARIABLES.has(name) || name.startsWith("LC_"))
        ? [[name, value]]
        : [],
    ),
  );

/** A whole decimal process id, digits only. */
const PROCESS_ID = v.pipe(
  v.string(),
  v.digits(),
  v.toNumber(),
  v.safeInteger(),
  v.minValue(1),
);

const instanceSchema = v.object({
  holderPid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  browserPid: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

type InstanceRecord = v.InferOutput<typeof instanceSchema>;

const readInstance = (file: string): InstanceRecord | null => {
  const text = Result.try(() => readFileSync(file, "utf-8"));
  if (Result.isError(text)) {
    return null;
  }
  const json = Result.try((): unknown => JSON.parse(text.value));
  if (Result.isError(json)) {
    return null;
  }
  const parsed = v.safeParse(instanceSchema, json.value);
  return parsed.success ? parsed.output : null;
};

/** Records which holder runs which browser on the profile, readable by this user only. */
export const writeInstance = (file: string, record: InstanceRecord): void => {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  const written = Result.try(() => {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, file);
  });
  if (Result.isError(written)) {
    rmSync(temporary, { force: true });
  }
};

/** The process table, as ending an orphan reads and changes it. */
export type BrowserProcesses = {
  alive: (pid: number) => boolean;
  /** The process's command line, or null when it cannot be read. */
  commandLine: (pid: number) => string | null;
  /** Sends `signal`; false when the process is gone already. */
  signal: (pid: number, signal: "SIGKILL" | "SIGTERM") => boolean;
};

export const realBrowserProcesses: BrowserProcesses = {
  alive: (pid) => Result.isOk(Result.try(() => process.kill(pid, 0))),
  commandLine: (pid) => {
    // `ps` on macOS and Linux alike; -ww keeps the whole line.
    const read = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    });
    return read.status === 0 ? read.stdout.trim() : null;
  },
  signal: (pid, signal) =>
    Result.isOk(Result.try(() => process.kill(pid, signal))),
};

/**
 * The process Chrome's `SingletonLock` names: the lock is a symlink to
 * `<host>-<pid>`. Null without a lock, or for a lock another computer
 * holds (a profile on a shared drive).
 */
export const singletonLockPid = (profileDir: string): number | null => {
  const target = Result.try(() =>
    readlinkSync(path.join(profileDir, "SingletonLock")),
  );
  if (Result.isError(target)) {
    return null;
  }
  const separator = target.value.lastIndexOf("-");
  const host = target.value.slice(0, separator);
  const pid = v.safeParse(PROCESS_ID, target.value.slice(separator + 1));
  return separator > 0 && host === hostname() && pid.success
    ? pid.output
    : null;
};

const ORPHAN_TERM_MS = 5000;
const ORPHAN_KILL_MS = 5000;
const ORPHAN_POLL_MS = 100;

const waitForExit = async (
  processes: BrowserProcesses,
  pid: number,
  ms: number,
): Promise<boolean> => {
  for (let waited = 0; waited < ms; waited += ORPHAN_POLL_MS) {
    if (!processes.alive(pid)) {
      return true;
    }
    await Bun.sleep(ORPHAN_POLL_MS);
  }
  return !processes.alive(pid);
};

export type OrphanOutcome =
  /** No browser runs on the profile. */
  | { type: "none" }
  /** A browser a dead holder left was ended. */
  | { type: "ended"; pid: number }
  /** Another process holds the profile: a live holder's browser, or not ours. */
  | { type: "in-use" };

/**
 * Before a launch: a browser that still runs on the profile must go, or
 * the new launch would hand off to it and exit, leaving a dead pipe. One is
 * ended only when its command line is the stella browser's own, on this
 * profile, and the holder that started it is gone; anything else holding
 * the profile refuses the launch.
 */
export const clearOrphan = async ({
  profile,
  processes,
  waits = { killMs: ORPHAN_KILL_MS, termMs: ORPHAN_TERM_MS },
}: {
  profile: BrowserProfile;
  processes: BrowserProcesses;
  /** How long an orphan gets to exit after each signal. */
  waits?: { killMs: number; termMs: number };
}): Promise<OrphanOutcome> => {
  const instance = readInstance(profile.instanceFile);
  const locked = singletonLockPid(profile.profileDir);
  const candidates = [
    ...new Set([
      ...(instance === null ? [] : [instance.browserPid]),
      ...(locked === null ? [] : [locked]),
    ]),
  ].filter((pid) => pid !== process.pid && processes.alive(pid));
  for (const pid of candidates) {
    // Arguments end at a space: a profile whose path extends this one's is
    // another profile.
    const line = ` ${processes.commandLine(pid) ?? ""} `;
    const ours =
      line.includes(` --user-data-dir=${profile.profileDir} `) &&
      line.includes(" --remote-debugging-pipe ");
    if (!ours) {
      // A process the lock names that is not ours holds the profile; a
      // recorded browser id taken by another process since is not ours to end.
      if (pid === locked) {
        return { type: "in-use" };
      }
      continue;
    }
    const holder = instance?.browserPid === pid ? instance.holderPid : null;
    if (holder !== null && holder !== process.pid && processes.alive(holder)) {
      return { type: "in-use" };
    }
    processes.signal(pid, "SIGTERM");
    if (!(await waitForExit(processes, pid, waits.termMs))) {
      processes.signal(pid, "SIGKILL");
      if (!(await waitForExit(processes, pid, waits.killMs))) {
        return { type: "in-use" };
      }
    }
    return { pid, type: "ended" };
  }
  return { type: "none" };
};

/** A started browser: its process and the holder's ends of its pipe. */
export type LaunchedBrowser = {
  child: ChildProcess;
  pid: number;
  /** The browser's fd 3. */
  input: NodeJS.WritableStream & { destroy: () => void };
  /** The browser's fd 4. */
  output: NodeJS.ReadableStream & { destroy: () => void };
};

const isWritable = (
  stream: unknown,
): stream is NodeJS.WritableStream & { destroy: () => void } =>
  typeof stream === "object" &&
  stream !== null &&
  "write" in stream &&
  "destroy" in stream;

const isReadable = (
  stream: unknown,
): stream is NodeJS.ReadableStream & { destroy: () => void } =>
  typeof stream === "object" &&
  stream !== null &&
  "on" in stream &&
  "destroy" in stream;

/**
 * Spawns the browser in its own process group, outside the harnesses'
 * process trees, with fds 3 and 4 as the protocol pipe. `node:child_process`
 * rather than `Bun.spawn`: it hands the extra pipes back as streams, and the
 * holder's ends are close-on-exec, so no process started later inherits
 * them.
 */
export const spawnBrowser = async ({
  args,
  environment,
  errorLog = null,
  executable,
}: {
  args: readonly string[];
  environment: Record<string, string>;
  /** A file the browser's error output is appended to; null discards it. */
  errorLog?: string | null;
  executable: string;
}): Promise<Result<LaunchedBrowser, { message: string }>> => {
  const errors =
    errorLog === null ? null : Result.try(() => openSync(errorLog, "a", 0o600));
  const child = spawn(executable, [...args], {
    detached: true,
    env: environment,
    stdio: [
      "ignore",
      "ignore",
      errors !== null && Result.isOk(errors) ? errors.value : "ignore",
      "pipe",
      "pipe",
    ],
  });
  // The child holds its own copy of the log's descriptor.
  if (errors !== null && Result.isOk(errors)) {
    closeSync(errors.value);
  }
  // A start that failed (no such file, not executable) has no process id
  // and reports an error event; Bun may emit `spawn` before a listener is
  // attached, so the id is what counts.
  const failed = { error: false };
  child.on("error", () => {
    failed.error = true;
  });
  await Bun.sleep(0);
  const input: unknown = child.stdio[3];
  const output: unknown = child.stdio[4];
  if (
    failed.error ||
    child.pid === undefined ||
    !isWritable(input) ||
    !isReadable(output)
  ) {
    child.kill("SIGKILL");
    return Result.err({ message: "The browser did not start." });
  }
  return Result.ok({ child, input, output, pid: child.pid });
};
