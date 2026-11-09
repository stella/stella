import { EventType } from "@tanstack/ai";
import { panic, Result, TaggedError } from "better-result";
import { lstatSync, type Stats } from "node:fs";
import {
  chmod,
  constants,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_CHECKPOINT_EVENT,
  type DESKTOP_RUNNER_CHECKPOINT_UNAVAILABLE_REASONS,
  type DesktopRunnerCheckpointEvent,
} from "@stll/api-contract/desktop-runner";
import { createDetached } from "@stll/errors";
import { createSha256 } from "@stll/sha256/bun";

import { SIDECAR_CHECKPOINT_STORE_SUFFIX } from "./protocol";

/**
 * A run's folder as it stood before its turn, so the member can undo what the
 * turn changed there. The sidecar saves the folder once per run, after the
 * run's attachments are copied and before its harness starts; restoring puts
 * the folder back as it was saved.
 *
 * Saved beside the folder (`<folder>.checkpoints/`), never inside it: the
 * agent's sandbox can write in the folder only, so it can neither forge nor
 * remove a checkpoint. Files are stored once by content
 * (`objects/<sha256[0..2]>/<sha256>`) and each checkpoint is a manifest of the
 * folder's entries (`manifests/<runId>.json`), written last. A restore first
 * writes the folder's current state as a recovery manifest
 * (`recovery/<id>.json`), kept with its files until the folder is either
 * restored or verifiably put back.
 *
 * Captures, restores, pruning and cleanup of one store run one at a time: in
 * this process through a queue per store, and across processes (a draining
 * holder and its successor can both run turns in one chat's folder) through a
 * lock file in the store that names its holder's process.
 *
 * The agent can write in the folder and this process runs outside its
 * sandbox, so nothing here follows a link: a link is saved and restored as a
 * link, a file is read through a descriptor opened without following one, and
 * every folder on the way to an entry is checked to be a plain folder. Skill
 * folders, the package cache and the CLI's home are outside the folder and
 * are never read or written; a folder that holds one of them is not saved.
 *
 * Windows: a link in the folder makes it unsaved (`unsupported`), as do names
 * the platform reserves; modes are neither saved nor restored. Paths are
 * compared exactly: removals run before writes, so a name whose case the
 * turn changed is removed and written back under its saved case on a
 * case-insensitive filesystem too.
 */

export type CheckpointLimits = {
  /** Entries one capture saves; a dependency tree is not saved. */
  maxEntries: number;
  /** Folders deep below the run's folder. */
  maxDepth: number;
  maxFileBytes: number;
  /** Bytes one capture reads into the store. */
  maxNewBytes: number;
  maxCaptureMs: number;
  /** Checkpoints kept per folder, newest first. */
  maxManifests: number;
  /** Bytes of stored files per folder; the newest checkpoint is always kept. */
  maxStoredBytes: number;
  /** Bytes of one manifest; a folder past it is not saved. */
  maxManifestBytes: number;
  /** How long a capture or restore waits for another one on the same store. */
  lockWaitMs: number;
  /** How often a holder refreshes its lock; five missed beats make it stale. */
  lockHeartbeatMs: number;
};

export const CHECKPOINT_LIMITS: CheckpointLimits = {
  maxEntries: 5000,
  maxDepth: 8,
  maxFileBytes: 256 * 1024 * 1024,
  maxNewBytes: 1024 * 1024 * 1024,
  maxCaptureMs: 15_000,
  maxManifests: 20,
  maxStoredBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  lockWaitMs: 30_000,
  lockHeartbeatMs: 2000,
};

export type CheckpointUnavailableReason =
  (typeof DESKTOP_RUNNER_CHECKPOINT_UNAVAILABLE_REASONS)[number];

/** What a restore did; the host adds `folder_busy` before it starts one. */
type CheckpointRestoreOutcome =
  "restored" | "no_checkpoint" | "not_newest" | "failed";

export type CheckpointRestore = {
  outcome: CheckpointRestoreOutcome;
  /** Why it failed, for the log; never a path or a file name. */
  detail: string | null;
};

const OBJECTS = "objects";
const MANIFESTS = "manifests";
const RECOVERY = "recovery";
const LOCK_FILE = ".lock";
const MANIFEST_VERSION = 1;
const LOCK_POLL_MS = 50;
/** A lock its holder stopped refreshing for this many heartbeats is stale. */
const LOCK_STALE_HEARTBEATS = 5;
const COPY_CHUNK_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;
const MODE_BITS = 0o777;
const RESTORE_TEMP_PREFIX = ".stella-restore-";
const TEMP_OBJECT_PREFIX = "tmp-";

const isWindows = () => process.platform === "win32";

/** A flag the platform has, or none: Windows defines neither of these two. */
const platformFlag = (name: "O_NOFOLLOW" | "O_NONBLOCK") =>
  name in constants ? constants[name] : 0;

/**
 * Read-only (the zero flag) without following a link, and non-blocking so a
 * pipe swapped in for a file cannot hold the read. Distinct bits: their sum is
 * their union.
 */
const READ_FLAGS = platformFlag("O_NOFOLLOW") + platformFlag("O_NONBLOCK");

/** Created, never reopened: refuses whatever is already at the name. */
const CREATE_FLAGS = "wx";

/** `<folder>.checkpoints`, beside the run's folder. */
export const checkpointStoreOf = (workspaceDir: string) => {
  const folder = path.resolve(workspaceDir);
  return path.join(
    path.dirname(folder),
    `${path.basename(folder)}${SIDECAR_CHECKPOINT_STORE_SUFFIX}`,
  );
};

const objectPath = (store: string, sha256: string) =>
  path.join(store, OBJECTS, sha256.slice(0, 2), sha256);

const manifestPath = (store: string, runId: string) =>
  path.join(store, MANIFESTS, `${runId}.json`);

/** Names Windows reserves, with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;

const isUnsupportedName = (name: string) =>
  isWindows() &&
  (WINDOWS_RESERVED_NAME.test(name) ||
    name.endsWith(".") ||
    name.endsWith(" ") ||
    name.includes(":"));

/** A `/`-separated path that stays inside the folder it is joined to. */
const isInsidePath = (value: string) =>
  !value.startsWith("/") &&
  !value.includes("\0") &&
  !(isWindows() && (value.includes("\\") || value.includes(":"))) &&
  value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const relativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.check(isInsidePath, "A path inside the run's folder"),
);
const modeSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(MODE_BITS),
);
const statNumberSchema = v.pipe(v.number(), v.minValue(0));
const sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

const entrySchema = v.variant("kind", [
  v.object({
    kind: v.literal("file"),
    path: relativePathSchema,
    sha256: sha256Schema,
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    mode: modeSchema,
    /** What the file's state was read from; an unchanged file is not reread. */
    stat: v.object({
      ino: statNumberSchema,
      mtimeMs: statNumberSchema,
      ctimeMs: statNumberSchema,
    }),
  }),
  v.object({
    kind: v.literal("dir"),
    path: relativePathSchema,
    mode: modeSchema,
  }),
  v.object({
    kind: v.literal("link"),
    path: relativePathSchema,
    linkTarget: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  }),
]);

type Entry = v.InferOutput<typeof entrySchema>;
type FileEntry = Extract<Entry, { kind: "file" }>;
type StatKey = FileEntry["stat"];

const manifestSchema = v.object({
  version: v.literal(MANIFEST_VERSION),
  runId: v.pipe(v.string(), v.uuid()),
  /** Orders a folder's checkpoints; the clock does not. */
  ordinal: v.pipe(v.number(), v.integer(), v.minValue(1)),
  takenAt: v.pipe(v.string(), v.isoTimestamp()),
  /** Restored once; an undone checkpoint is never restored again. */
  undone: v.boolean(),
  entries: v.array(entrySchema),
  /** The attachments copied into the folder for this run. */
  memberFiles: v.array(relativePathSchema),
});

type Manifest = v.InferOutput<typeof manifestSchema>;

/** The folder as a restore found it, kept until the restore is settled. */
const recoverySchema = v.object({
  version: v.literal(MANIFEST_VERSION),
  /** The checkpoint the restore was putting back. */
  restoreOf: v.pipe(v.string(), v.uuid()),
  savedAt: v.pipe(v.string(), v.isoTimestamp()),
  entries: v.array(entrySchema),
});

type Recovery = v.InferOutput<typeof recoverySchema>;

class CheckpointRefused extends TaggedError("CheckpointRefused")<{
  reason: CheckpointUnavailableReason;
  message: string;
  cause?: unknown;
}> {}

class CheckpointRestoreFailed extends TaggedError("CheckpointRestoreFailed")<{
  message: string;
  cause?: unknown;
}> {}

const refused =
  (reason: CheckpointUnavailableReason, message: string) => (cause?: unknown) =>
    new CheckpointRefused({ reason, message, cause });

const restoreFailed = (message: string) => (cause?: unknown) =>
  new CheckpointRestoreFailed({ message, cause });

/** What is at `target`, without following a link; `undefined` is nothing. */
const entryAt = (target: string) =>
  lstatSync(target, { throwIfNoEntry: false });

const modeOf = (stat: Stats) => (isWindows() ? 0 : stat.mode % (MODE_BITS + 1));

/**
 * The change time is part of it: the agent can set a file's modified time
 * back, never its change time.
 */
const statKeyOf = (stat: Stats): StatKey => ({
  ino: stat.ino,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

const sameStat = (left: StatKey, right: StatKey) =>
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const isStoredObject = (store: string, sha256: string) =>
  entryAt(objectPath(store, sha256))?.isFile() === true;

/** A folder's names; a folder not made yet has none. */
const namesIn = async (folder: string) =>
  entryAt(folder) === undefined ? [] : await readdir(folder);

/** `inner` is `outer` or below it. */
const contains = (outer: string, inner: string) => {
  const from = path.resolve(outer);
  const to = path.resolve(inner);
  return to === from || to.startsWith(`${from}${path.sep}`);
};

type Walk = {
  workspaceDir: string;
  store: string;
  limits: CheckpointLimits;
  /** `performance.now()` when the walk started. */
  started: number;
  /** Files of an earlier checkpoint: one unchanged since keeps its object. */
  known: ReadonlyMap<string, FileEntry>;
  signal: AbortSignal | undefined;
  entries: Entry[];
  newBytes: number;
};

const outOfTime = (walk: Walk): CheckpointRefused | null => {
  if (walk.signal?.aborted === true) {
    return refused("failed", "The capture was stopped.")();
  }
  return performance.now() - walk.started >= walk.limits.maxCaptureMs
    ? refused("too_slow", "The folder took too long to save.")()
    : null;
};

/**
 * Copy the file into the store from a descriptor opened without following a
 * link, hashing it on the way. What was opened is what is judged and saved.
 */
const storeFile = async (
  walk: Walk,
  target: string,
  entryPath: string,
): Promise<Result<FileEntry, CheckpointRefused>> =>
  await Result.tryPromise({
    try: async (): Promise<Result<FileEntry, CheckpointRefused>> => {
      const source = await open(target, READ_FLAGS);
      const temp = path.join(
        walk.store,
        OBJECTS,
        `${TEMP_OBJECT_PREFIX}${crypto.randomUUID()}`,
      );
      try {
        const opened = await source.stat();
        if (!opened.isFile()) {
          return Result.err(
            refused("unsupported", "The folder holds a special file.")(),
          );
        }
        if (opened.size > walk.limits.maxFileBytes) {
          return Result.err(refused("too_large", "A file is too large.")());
        }
        const hash = createSha256();
        const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
        let size = 0;
        const sink = await open(temp, CREATE_FLAGS, PRIVATE_FILE_MODE);
        try {
          for (;;) {
            // await-in-loop: a chunk at a time keeps a large file out of memory.
            const { bytesRead } = await source.read(
              buffer,
              0,
              buffer.length,
              null,
            );
            if (bytesRead === 0) {
              break;
            }
            size += bytesRead;
            walk.newBytes += bytesRead;
            if (
              size > walk.limits.maxFileBytes ||
              walk.newBytes > walk.limits.maxNewBytes
            ) {
              return Result.err(
                refused("too_large", "The folder holds too much to save.")(),
              );
            }
            const late = outOfTime(walk);
            if (late !== null) {
              return Result.err(late);
            }
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            // await-in-loop: written in order, one chunk in memory.
            await sink.write(chunk);
          }
          await sink.sync();
        } finally {
          await sink.close();
        }
        const sha256 = hash.digest("hex");
        const stored = objectPath(walk.store, sha256);
        if (isStoredObject(walk.store, sha256)) {
          await rm(temp, { force: true });
        } else {
          await mkdir(path.dirname(stored), {
            recursive: true,
            mode: PRIVATE_FOLDER_MODE,
          });
          await rename(temp, stored);
        }
        return Result.ok({
          kind: "file",
          path: entryPath,
          sha256,
          size,
          mode: modeOf(opened),
          stat: statKeyOf(opened),
        });
      } finally {
        await source.close();
        await rm(temp, { force: true });
      }
    },
    catch: refused("failed", "A file could not be saved."),
  }).then((outcome) => (Result.isOk(outcome) ? outcome.value : outcome));

const saveFile = async (
  walk: Walk,
  target: string,
  entryPath: string,
  stat: Stats,
): Promise<Result<FileEntry, CheckpointRefused>> => {
  const size = stat.size;
  if (size > walk.limits.maxFileBytes) {
    return Result.err(refused("too_large", "A file is too large.")());
  }
  const known = walk.known.get(entryPath);
  if (known?.size === size && sameStat(known.stat, statKeyOf(stat))) {
    const stored = Result.try({
      try: () => isStoredObject(walk.store, known.sha256),
      catch: refused("failed", "The checkpoint store could not be read."),
    });
    if (Result.isError(stored)) {
      return stored;
    }
    if (stored.value) {
      return Result.ok({ ...known, mode: modeOf(stat) });
    }
  }
  return await storeFile(walk, target, entryPath);
};

const readLink = async (target: string) =>
  await Result.tryPromise({
    try: async () => await readlink(target),
    catch: refused("failed", "A link could not be read."),
  });

/** Save one folder's entries, in a stable order, then its subfolders'. */
const walkFolder = async (
  walk: Walk,
  folder: string,
  relative: string,
  depth: number,
): Promise<Result<void, CheckpointRefused>> =>
  await Result.gen(async function* () {
    const names = yield* Result.await(
      Result.tryPromise({
        try: async () => await readdir(folder),
        catch: refused("failed", "A folder could not be listed."),
      }),
    );
    for (const name of names.toSorted()) {
      const late = outOfTime(walk);
      if (late !== null) {
        return Result.err(late);
      }
      if (walk.entries.length >= walk.limits.maxEntries) {
        return Result.err(
          refused("too_large", "The folder holds too many entries.")(),
        );
      }
      if (depth > walk.limits.maxDepth) {
        return Result.err(refused("too_large", "The folder is too deep.")());
      }
      if (isUnsupportedName(name)) {
        return Result.err(
          refused("unsupported", "A name the platform reserves.")(),
        );
      }
      const target = path.join(folder, name);
      const entryPath = relative === "" ? name : `${relative}/${name}`;
      const stat = yield* Result.try({
        try: () => entryAt(target),
        catch: refused("failed", "An entry could not be read."),
      });
      if (stat === undefined) {
        // Gone since the folder was listed.
        continue;
      }
      if (stat.isDirectory()) {
        walk.entries.push({ kind: "dir", path: entryPath, mode: modeOf(stat) });
        // await-in-loop: one folder at a time, under the caps.
        yield* Result.await(walkFolder(walk, target, entryPath, depth + 1));
      } else if (stat.isSymbolicLink()) {
        if (isWindows()) {
          return Result.err(
            refused("unsupported", "The folder holds a link.")(),
          );
        }
        // await-in-loop: one entry at a time.
        const linkTarget = yield* Result.await(readLink(target));
        walk.entries.push({ kind: "link", path: entryPath, linkTarget });
      } else if (stat.isFile()) {
        // await-in-loop: one file in memory at a time.
        walk.entries.push(
          yield* Result.await(saveFile(walk, target, entryPath, stat)),
        );
      } else {
        return Result.err(
          refused("unsupported", "The folder holds a special file.")(),
        );
      }
    }
    return Result.ok();
  });

type WalkOptions = {
  workspaceDir: string;
  store: string;
  limits: CheckpointLimits;
  known: readonly Entry[];
  signal?: AbortSignal | undefined;
};

/** The folder's entries, each file stored; parents come before children. */
const saveTree = async ({
  workspaceDir,
  store,
  limits,
  known,
  signal,
}: WalkOptions): Promise<Result<Entry[], CheckpointRefused>> =>
  await Result.gen(async function* () {
    const walk: Walk = {
      workspaceDir,
      store,
      limits,
      started: performance.now(),
      known: new Map(
        known.flatMap((entry) =>
          entry.kind === "file" ? [[entry.path, entry]] : [],
        ),
      ),
      signal,
      entries: [],
      newBytes: 0,
    };
    const root = yield* Result.try({
      try: () => entryAt(workspaceDir),
      catch: refused("failed", "The folder could not be read."),
    });
    if (root === undefined) {
      // No folder yet: it was empty.
      return Result.ok([]);
    }
    if (!root.isDirectory()) {
      return Result.err(
        refused("failed", "The run's folder is not a folder.")(),
      );
    }
    yield* Result.await(walkFolder(walk, workspaceDir, "", 0));
    return Result.ok(walk.entries);
  });

/** The store's folders, made for the member alone; never through a link. */
const openStore = async (store: string) =>
  await Result.gen(async function* () {
    for (const folder of [
      store,
      path.join(store, OBJECTS),
      path.join(store, MANIFESTS),
      path.join(store, RECOVERY),
    ]) {
      const existing = yield* Result.try({
        try: () => entryAt(folder),
        catch: refused("failed", "The checkpoint store could not be read."),
      });
      if (existing !== undefined && !existing.isDirectory()) {
        return Result.err(
          refused("failed", "The checkpoint store is not a folder.")(),
        );
      }
      if (existing === undefined) {
        // await-in-loop: the parent comes first.
        yield* Result.await(
          Result.tryPromise({
            try: async () => {
              await mkdir(folder, { mode: PRIVATE_FOLDER_MODE });
            },
            catch: refused("failed", "The checkpoint store could not be made."),
          }),
        );
      }
    }
    return Result.ok();
  });

const errorCode = (cause: unknown) =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

/** The text as a value of `schema`; `null` when it is not one. */
const parsedAs = <T>(
  schema: v.GenericSchema<unknown, T>,
  text: string | null,
): T | null => {
  if (text === null) {
    return null;
  }
  const json = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(json)) {
    return null;
  }
  const parsed = v.safeParse(schema, json.value);
  return parsed.success ? parsed.output : null;
};

/** What a lock file holds: the process that took it, and a token of its own. */
const lockSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  token: v.pipe(v.string(), v.uuid()),
});

type Lock = v.InferOutput<typeof lockSchema>;

/** The lock file's holder; `null` when there is none or it cannot be told. */
const lockAt = async (file: string) => {
  if (entryAt(file) === undefined) {
    return null;
  }
  return parsedAs(lockSchema, await readFile(file, "utf-8"));
};

/**
 * Whether a lock's holder is gone: its process exited, or it stopped
 * refreshing the lock for several heartbeats (its process id may have been
 * reused). A lock that cannot be read is judged by its age alone.
 */
const isStaleLock = async (lock: string, limits: CheckpointLimits) => {
  const stat = entryAt(lock);
  if (stat === undefined) {
    return false;
  }
  const age = Temporal.Now.instant().epochMilliseconds - stat.mtimeMs;
  if (age > limits.lockHeartbeatMs * LOCK_STALE_HEARTBEATS) {
    return true;
  }
  const holder = await lockAt(lock);
  if (holder === null) {
    return false;
  }
  const alive = Result.try({
    try: () => process.kill(holder.pid, 0),
    catch: (cause) => cause,
  });
  // EPERM: alive, under another user.
  return Result.isError(alive) && errorCode(alive.error) === "ESRCH";
};

/**
 * Remove a stale lock without removing a fresh one that replaced it: the lock
 * is moved to a name of its own first, and removed only when it is still the
 * one judged stale; otherwise it is put back.
 */
const reclaimLock = async (lock: string, judged: Lock | null) => {
  const moved = path.join(
    path.dirname(lock),
    `${LOCK_FILE}-stale-${crypto.randomUUID()}`,
  );
  const stillStale = await Result.tryPromise({
    try: async () => {
      await rename(lock, moved);
      const found = await lockAt(moved);
      return judged === null || found?.token === judged.token;
    },
    catch: (cause) => cause,
  });
  if (Result.isError(stillStale)) {
    return stillStale;
  }
  // A new holder took the lock between the check and the move: it goes
  // back, unless yet another holder has published one since.
  const putBack = stillStale.value
    ? Result.ok()
    : await Result.tryPromise({
        try: async () => {
          await link(moved, lock);
        },
        catch: (cause) => cause,
      });
  const removed = await Result.tryPromise({
    try: async () => {
      await rm(moved, { force: true });
    },
    catch: (cause) => cause,
  });
  return Result.isError(putBack) && errorCode(putBack.error) !== "EEXIST"
    ? putBack
    : removed;
};

/**
 * Remove what crashed holders left of their locks: drafts and moved stale
 * locks, once they are older than a stale lock.
 */
const sweepLockLeftovers = async (store: string, limits: CheckpointLimits) => {
  const now = Temporal.Now.instant().epochMilliseconds;
  for (const name of await namesIn(store)) {
    const leftover = path.join(store, name);
    const stat = name.startsWith(`${LOCK_FILE}-`)
      ? entryAt(leftover)
      : undefined;
    if (
      stat !== undefined &&
      now - stat.mtimeMs > limits.lockHeartbeatMs * LOCK_STALE_HEARTBEATS
    ) {
      // await-in-loop: removals one at a time.
      await rm(leftover, { force: true });
    }
  }
};

/**
 * Take the store's lock file, waiting while another process holds it. The
 * lock is written in full under a name of its own and published with a hard
 * link, which refuses an existing lock: no holder ever sees a half-written
 * one. A lock whose holder is gone is taken over.
 */
const takeLock = async (
  store: string,
  limits: CheckpointLimits,
): Promise<Result<Lock, CheckpointRefused>> => {
  const lock = path.join(store, LOCK_FILE);
  const mine: Lock = { pid: process.pid, token: crypto.randomUUID() };
  const draft = path.join(store, `${LOCK_FILE}-${mine.token}`);
  const deadline = performance.now() + limits.lockWaitMs;
  const written = await Result.tryPromise({
    try: async () => {
      const handle = await open(draft, CREATE_FLAGS, PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(mine));
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    catch: refused("failed", "The checkpoint store could not be locked."),
  });
  if (Result.isError(written)) {
    return written;
  }
  try {
    for (;;) {
      // await-in-loop: one attempt at a time until the lock is free.
      const published = await Result.tryPromise({
        try: async () => {
          await link(draft, lock);
        },
        catch: (cause) => cause,
      });
      if (Result.isOk(published)) {
        return Result.ok(mine);
      }
      if (errorCode(published.error) !== "EEXIST") {
        return Result.err(
          refused(
            "failed",
            "The checkpoint store could not be locked.",
          )(published.error),
        );
      }
      // await-in-loop: the holder is read before it is judged.
      const judged = await Result.tryPromise({
        try: async () => await lockAt(lock),
        catch: (cause) => cause,
      });
      // await-in-loop: checked before each new attempt.
      const stale = await Result.tryPromise({
        try: async () => await isStaleLock(lock, limits),
        catch: (cause) => cause,
      });
      if (Result.isOk(judged) && Result.isOk(stale) && stale.value) {
        // await-in-loop: the stale lock goes before the next attempt.
        const reclaimed = await reclaimLock(lock, judged.value);
        if (Result.isOk(reclaimed)) {
          continue;
        }
      }
      if (performance.now() >= deadline) {
        return Result.err(
          refused("failed", "Another process holds the checkpoint store.")(),
        );
      }
      // real-time: another process holds the lock; it is polled until free.
      // await-in-loop: one wait between attempts.
      await Bun.sleep(LOCK_POLL_MS);
    }
  } finally {
    await rm(draft, { force: true });
  }
};

/** Refresh the lock's time while it is ours, so it never looks stale. */
const keepLock = (
  store: string,
  mine: Lock,
  limits: CheckpointLimits,
  log: (line: string) => void,
) => {
  const lock = path.join(store, LOCK_FILE);
  const beat = async () => {
    const holder = await lockAt(lock);
    if (holder?.token === mine.token) {
      const now = new Date();
      await utimes(lock, now, now);
    }
  };
  // A missed beat is logged and retried on the next one.
  const detached = createDetached((_error, context) => {
    log(`checkpoint store work failed: ${context}`);
  });
  const timer = setInterval(() => {
    detached(beat(), "checkpoints.heartbeat");
  }, limits.lockHeartbeatMs);
  return () => {
    clearInterval(timer);
  };
};

/** Give the lock up, unless it is no longer ours. */
const releaseLock = async (store: string, mine: Lock) =>
  await Result.tryPromise({
    try: async () => {
      const lock = path.join(store, LOCK_FILE);
      if ((await lockAt(lock))?.token === mine.token) {
        await rm(lock, { force: true });
      }
    },
    catch: refused("failed", "The checkpoint store could not be unlocked."),
  });

/** Work on one store, in this process queued after the work before it. */
const storeQueues = new Map<string, Promise<null>>();

/**
 * Run `work` with the store to itself: after earlier work on it in this
 * process, and holding its lock file against other processes.
 */
const withStore = async <T>(
  store: string,
  limits: CheckpointLimits,
  log: (line: string) => void,
  work: () => Promise<Result<T, CheckpointRefused>>,
): Promise<Result<T, CheckpointRefused>> => {
  const before = storeQueues.get(store) ?? Promise.resolve(null);
  const { promise: done, resolve: finish } = Promise.withResolvers<null>();
  storeQueues.set(store, done);
  await before;
  try {
    return await Result.gen(async function* () {
      yield* Result.await(openStore(store));
      const mine = yield* Result.await(takeLock(store, limits));
      const stopBeating = keepLock(store, mine, limits, log);
      const swept = await Result.tryPromise({
        try: async () => {
          await sweepLockLeftovers(store, limits);
        },
        catch: refused("failed", "Old lock files could not be removed."),
      });
      if (Result.isError(swept)) {
        log(`checkpoint store: ${swept.error.message}`);
      }
      const outcome = await Result.tryPromise({
        try: work,
        catch: refused("failed", "The checkpoint store failed."),
      }).then((result) => (Result.isOk(result) ? result.value : result));
      stopBeating();
      const released = await releaseLock(store, mine);
      return Result.isError(released) && Result.isOk(outcome)
        ? released
        : outcome;
    });
  } finally {
    finish(null);
    if (storeQueues.get(store) === done) {
      storeQueues.delete(store);
    }
  }
};

type StoredText = {
  file: string;
  name: string;
  /** `null` past the size a manifest may have: invalid without reading it. */
  text: string | null;
};

/**
 * The files of one store folder. A failure to list, open or read is an
 * error: it says nothing about the content, so nothing may be dropped for it.
 */
const readTexts = async (folder: string, maxBytes: number) =>
  await Result.tryPromise({
    try: async () => {
      const texts: StoredText[] = [];
      for (const name of (await namesIn(folder)).toSorted()) {
        const file = path.join(folder, name);
        const stat = entryAt(file);
        if (stat?.isFile() !== true) {
          // Gone since the listing, or not a file: not ours to judge.
          continue;
        }
        if (stat.size > maxBytes) {
          texts.push({ file, name, text: null });
          continue;
        }
        // await-in-loop: one file in memory at a time.
        const handle = await open(file, READ_FLAGS);
        try {
          // await-in-loop: one file in memory at a time.
          texts.push({ file, name, text: await handle.readFile("utf-8") });
        } finally {
          // await-in-loop: closed before the next one opens.
          await handle.close();
        }
      }
      return texts;
    },
    catch: refused("failed", "The checkpoints could not be read."),
  });

type StoreState = {
  /** Valid manifests, oldest first. */
  manifests: Manifest[];
  /** Manifest files whose content is not a manifest: safe to drop. */
  invalid: string[];
  /** States restores saved and could not drop: their files are kept. */
  recoveries: Recovery[];
};

const readStore = async (store: string, limits: CheckpointLimits) =>
  await Result.gen(async function* () {
    const manifestTexts = yield* Result.await(
      readTexts(path.join(store, MANIFESTS), limits.maxManifestBytes),
    );
    const recoveryTexts = yield* Result.await(
      readTexts(path.join(store, RECOVERY), limits.maxManifestBytes),
    );
    const manifests: Manifest[] = [];
    const invalid: string[] = [];
    for (const { file, name, text } of manifestTexts) {
      const manifest = parsedAs(manifestSchema, text);
      if (manifest !== null && name === `${manifest.runId}.json`) {
        manifests.push(manifest);
      } else {
        invalid.push(file);
      }
    }
    const state: StoreState = {
      manifests: manifests.toSorted(
        (left, right) => left.ordinal - right.ordinal,
      ),
      invalid,
      recoveries: recoveryTexts.flatMap(({ text }) => {
        const recovery = parsedAs(recoverySchema, text);
        return recovery === null ? [] : [recovery];
      }),
    };
    return Result.ok(state);
  });

/**
 * Written to a fresh name, flushed, then renamed: whole or absent. Past
 * `maxBytes` nothing is written and the capture is too large.
 */
const writeJson = async (target: string, value: unknown, maxBytes: number) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) {
    return Result.err(refused("too_large", "The checkpoint is too large.")());
  }
  return await Result.tryPromise({
    try: async () => {
      const temp = path.join(
        path.dirname(target),
        `.${TEMP_OBJECT_PREFIX}${crypto.randomUUID()}`,
      );
      try {
        const handle = await open(temp, CREATE_FLAGS, PRIVATE_FILE_MODE);
        try {
          await handle.writeFile(text);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    },
    catch: refused("failed", "The checkpoint could not be written."),
  });
};

const writeManifest = async (
  store: string,
  manifest: Manifest,
  limits: CheckpointLimits,
) =>
  await writeJson(
    manifestPath(store, manifest.runId),
    manifest,
    limits.maxManifestBytes,
  );

const storedBytes = (saved: readonly { entries: readonly Entry[] }[]) => {
  const sizes = new Map<string, number>();
  for (const manifest of saved) {
    for (const entry of manifest.entries) {
      if (entry.kind === "file") {
        sizes.set(entry.sha256, entry.size);
      }
    }
  }
  return [...sizes.values()].reduce((total, size) => total + size, 0);
};

/**
 * Remove every stored file that no kept manifest and no recovery names, and
 * stale temp files. Only called with the store to itself.
 */
const collectGarbage = async (
  store: string,
  kept: readonly Manifest[],
  recoveries: readonly Recovery[],
) =>
  await Result.tryPromise({
    try: async () => {
      const referenced = new Set(
        [...kept, ...recoveries].flatMap((saved) =>
          saved.entries.flatMap((entry) =>
            entry.kind === "file" ? [entry.sha256] : [],
          ),
        ),
      );
      const objects = path.join(store, OBJECTS);
      for (const bucket of await namesIn(objects)) {
        const folder = path.join(objects, bucket);
        if (bucket.startsWith(TEMP_OBJECT_PREFIX)) {
          // await-in-loop: removals one at a time.
          await rm(folder, { force: true });
          continue;
        }
        // await-in-loop: one bucket listed at a time.
        for (const name of await namesIn(folder)) {
          if (!referenced.has(name)) {
            // await-in-loop: removals one at a time.
            await rm(path.join(folder, name), { force: true });
          }
        }
      }
    },
    catch: refused("failed", "Unused stored files could not be removed."),
  });

/**
 * Keep the newest checkpoints within the folder's bounds: oldest first, never
 * the newest; then remove what nothing names. A store that cannot be read
 * removes nothing.
 */
const prune = async (store: string, limits: CheckpointLimits) =>
  await Result.gen(async function* () {
    const state = yield* Result.await(readStore(store, limits));
    const kept = state.manifests.slice(-Math.max(1, limits.maxManifests));
    // A restore's kept state counts too: its files stay as long as it does.
    while (
      kept.length > 1 &&
      storedBytes([...kept, ...state.recoveries]) > limits.maxStoredBytes
    ) {
      kept.shift();
    }
    const keptIds = new Set(kept.map(({ runId }) => runId));
    const dropped = [
      ...state.invalid,
      ...state.manifests
        .filter(({ runId }) => !keptIds.has(runId))
        .map(({ runId }) => manifestPath(store, runId)),
    ];
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          for (const file of dropped) {
            // await-in-loop: removals one at a time.
            await rm(file, { force: true });
          }
        },
        catch: refused("failed", "Older checkpoints could not be removed."),
      }),
    );
    return await collectGarbage(store, kept, state.recoveries);
  });

/**
 * The folder the checkpoint describes, plus the attachments later turns
 * copied: those turns are still in the chat, so their files stay.
 */
const desiredTree = (
  target: Manifest,
  later: readonly Manifest[],
): Map<string, Entry> => {
  const desired = new Map(target.entries.map((entry) => [entry.path, entry]));
  for (const manifest of later) {
    const byPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry]),
    );
    for (const memberFile of manifest.memberFiles) {
      const entry = byPath.get(memberFile);
      if (desired.has(memberFile) || entry?.kind !== "file") {
        continue;
      }
      const segments = memberFile.split("/");
      const folders = segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join("/"));
      const fits = folders.every((folder) => {
        const wanted = desired.get(folder) ?? byPath.get(folder);
        return wanted?.kind === "dir";
      });
      if (!fits) {
        continue;
      }
      for (const folder of folders) {
        const wanted = byPath.get(folder);
        if (!desired.has(folder) && wanted !== undefined) {
          desired.set(folder, wanted);
        }
      }
      desired.set(memberFile, entry);
    }
  }
  return desired;
};

/** One filesystem step of a restore; what it throws is its failure. */
const restoreStep = async (message: string, act: () => Promise<void>) =>
  await Result.tryPromise({ try: act, catch: restoreFailed(message) });

/** Each folder below the run's folder on the way to `relative` is a plain one. */
const checkParents = (
  workspaceDir: string,
  relative: string,
): Result<string, CheckpointRestoreFailed> => {
  let current = workspaceDir;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const folder = current;
    const stat = Result.try({
      try: () => entryAt(folder),
      catch: restoreFailed("A folder on the way could not be read."),
    });
    if (Result.isError(stat)) {
      return stat;
    }
    if (stat.value?.isDirectory() !== true) {
      return Result.err(
        restoreFailed("A folder on the way is not a plain folder.")(),
      );
    }
  }
  return Result.ok(path.join(workspaceDir, relative));
};

const OWNER_ACCESS = 7;
const OWNER_SHIFT = 64;

const ownerBits = (mode: number) => Math.floor(mode / OWNER_SHIFT) % 8;

const hasOwnerAccess = (mode: number) => ownerBits(mode) === OWNER_ACCESS;

/** The mode with read, write and search for the member. */
const withOwnerAccess = (mode: number) =>
  mode + (OWNER_ACCESS - ownerBits(mode)) * OWNER_SHIFT;

/** Whether two walks found the same tree: kinds, contents, modes, links. */
const sameTree = (left: readonly Entry[], right: readonly Entry[]) => {
  const key = (entry: Entry) => {
    switch (entry.kind) {
      case "file":
        return `f:${entry.path}:${entry.sha256}:${String(entry.mode)}`;
      case "dir":
        return `d:${entry.path}:${String(entry.mode)}`;
      case "link":
        return `l:${entry.path}:${entry.linkTarget}`;
      default:
        entry satisfies never;
        return panic("Unhandled checkpoint entry kind");
    }
  };
  const keys = (entries: readonly Entry[]) =>
    entries.map(key).toSorted().join("\n");
  return keys(left) === keys(right);
};

const sameKind = (wanted: Entry | undefined, existing: Entry) => {
  if (wanted === undefined || wanted.kind !== existing.kind) {
    return false;
  }
  return (
    wanted.kind !== "link" ||
    (existing.kind === "link" && existing.linkTarget === wanted.linkTarget)
  );
};

const byPath = (left: Entry, right: Entry) => {
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
};

/** Reread a stored file and check it still has the content it is named by. */
const verifyObject = async (store: string, entry: FileEntry) => {
  const handle = await open(objectPath(store, entry.sha256), READ_FLAGS);
  try {
    const hash = createSha256();
    const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
    let size = 0;
    for (;;) {
      // await-in-loop: a chunk at a time keeps a large file out of memory.
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return size === entry.size && hash.digest("hex") === entry.sha256;
  } finally {
    await handle.close();
  }
};

/** Write a stored file to a fresh name beside its place, then rename over it. */
const writeStored = async (
  workspaceDir: string,
  store: string,
  entry: FileEntry,
) =>
  await Result.gen(async function* () {
    const target = yield* checkParents(workspaceDir, entry.path);
    const temp = path.join(
      path.dirname(target),
      `${RESTORE_TEMP_PREFIX}${crypto.randomUUID()}`,
    );
    return await restoreStep("A file could not be written.", async () => {
      const source = await open(objectPath(store, entry.sha256), READ_FLAGS);
      try {
        const sink = await open(temp, CREATE_FLAGS, PRIVATE_FILE_MODE);
        try {
          const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
          for (;;) {
            // await-in-loop: a chunk at a time keeps a large file out of memory.
            const { bytesRead } = await source.read(
              buffer,
              0,
              buffer.length,
              null,
            );
            if (bytesRead === 0) {
              break;
            }
            // await-in-loop: written in order, one chunk in memory.
            await sink.write(buffer.subarray(0, bytesRead));
          }
          if (!isWindows()) {
            await sink.chmod(entry.mode);
          }
          await sink.sync();
        } finally {
          await sink.close();
        }
        await rename(temp, target);
      } finally {
        await source.close();
        await rm(temp, { force: true });
      }
    });
  });

/** Set a file's mode through a descriptor that did not follow a link. */
const chmodFile = async (workspaceDir: string, entry: FileEntry) =>
  await Result.gen(async function* () {
    const target = yield* checkParents(workspaceDir, entry.path);
    const changed = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const handle = await open(target, READ_FLAGS);
          try {
            if (!(await handle.stat()).isFile()) {
              return false;
            }
            await handle.chmod(entry.mode);
            return true;
          } finally {
            await handle.close();
          }
        },
        catch: restoreFailed("A file's mode could not be set."),
      }),
    );
    return changed
      ? Result.ok()
      : Result.err(restoreFailed("A file was replaced during the restore.")());
  });

const writeLink = async (
  workspaceDir: string,
  entry: Extract<Entry, { kind: "link" }>,
) =>
  await Result.gen(async function* () {
    const target = yield* checkParents(workspaceDir, entry.path);
    const temp = path.join(
      path.dirname(target),
      `${RESTORE_TEMP_PREFIX}${crypto.randomUUID()}`,
    );
    return await restoreStep("A link could not be made.", async () => {
      try {
        await symlink(entry.linkTarget, temp);
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    });
  });

/** Set a folder's mode, unless something else took its place. */
const chmodFolder = async (
  workspaceDir: string,
  entry: Extract<Entry, { kind: "dir" }>,
) =>
  await Result.gen(async function* () {
    const target = yield* checkParents(workspaceDir, entry.path);
    const changed = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          if (entryAt(target)?.isDirectory() !== true) {
            return false;
          }
          await chmod(target, entry.mode);
          return true;
        },
        catch: restoreFailed("A folder's mode could not be set."),
      }),
    );
    return changed
      ? Result.ok()
      : Result.err(
          restoreFailed("A folder was replaced during the restore.")(),
        );
  });

/**
 * Make the folder hold exactly `desired`, from the `existing` entries a walk
 * just saved: removals first (children before parents), then folders, then
 * files and links, then the folders' modes. Stops at the first failure.
 */
const applyTree = async (
  workspaceDir: string,
  store: string,
  desired: ReadonlyMap<string, Entry>,
  existing: ReadonlyMap<string, Entry>,
) =>
  await Result.gen(async function* () {
    const root = yield* Result.try({
      try: () => entryAt(workspaceDir),
      catch: restoreFailed("The folder could not be read."),
    });
    if (root === undefined) {
      // A folder removed since is made again; its parent is the app's own.
      yield* Result.await(
        restoreStep("The folder could not be made.", async () => {
          await mkdir(workspaceDir, { mode: PRIVATE_FOLDER_MODE });
        }),
      );
    }
    // Every folder the restore may write in is opened for the member first;
    // its final mode is set last.
    const opened = new Map<string, number>();
    if (!isWindows()) {
      for (const entry of [...existing.values()].toSorted(byPath)) {
        if (entry.kind === "dir" && !hasOwnerAccess(entry.mode)) {
          const mode = withOwnerAccess(entry.mode);
          // await-in-loop: parents are opened before their children.
          yield* Result.await(chmodFolder(workspaceDir, { ...entry, mode }));
          opened.set(entry.path, mode);
        }
      }
    }
    const removed = new Set<string>();
    const removals = [...existing.values()]
      .filter((entry) => !sameKind(desired.get(entry.path), entry))
      .toSorted(byPath)
      .toReversed();
    for (const entry of removals) {
      const target = yield* checkParents(workspaceDir, entry.path);
      // await-in-loop: children go before their folder, in order.
      yield* Result.await(
        restoreStep("An entry could not be removed.", async () => {
          const stat = entryAt(target);
          if (stat?.isDirectory() === true) {
            await rmdir(target);
          } else if (stat !== undefined) {
            await unlink(target);
          }
        }),
      );
      removed.add(entry.path);
    }
    const current = (entryPath: string) =>
      removed.has(entryPath) ? undefined : existing.get(entryPath);
    const wanted = [...desired.values()].toSorted(byPath);
    for (const entry of wanted) {
      if (entry.kind === "dir" && current(entry.path)?.kind !== "dir") {
        const target = yield* checkParents(workspaceDir, entry.path);
        // await-in-loop: a folder's parent is made first.
        yield* Result.await(
          restoreStep("A folder could not be made.", async () => {
            await mkdir(target, { mode: PRIVATE_FOLDER_MODE });
          }),
        );
      }
    }
    for (const entry of wanted) {
      const now = current(entry.path);
      if (entry.kind === "file") {
        if (now?.kind === "file" && now.sha256 === entry.sha256) {
          if (!isWindows() && now.mode !== entry.mode) {
            // await-in-loop: one file at a time.
            yield* Result.await(chmodFile(workspaceDir, entry));
          }
          continue;
        }
        // await-in-loop: one file in memory at a time.
        yield* Result.await(writeStored(workspaceDir, store, entry));
      } else if (entry.kind === "link" && now?.kind !== "link") {
        // await-in-loop: one entry at a time.
        yield* Result.await(writeLink(workspaceDir, entry));
      }
    }
    if (!isWindows()) {
      for (const entry of wanted.toReversed()) {
        const now = current(entry.path);
        const mode =
          now?.kind === "dir"
            ? (opened.get(entry.path) ?? now.mode)
            : PRIVATE_FOLDER_MODE;
        if (entry.kind === "dir" && mode !== entry.mode) {
          // await-in-loop: deepest folders first.
          yield* Result.await(chmodFolder(workspaceDir, entry));
        }
      }
    }
    return Result.ok();
  });

type RestoreOptions = {
  workspaceDir: string;
  /** The run whose checkpoint to restore: the folder as it was before it. */
  runId: string;
  limits?: CheckpointLimits;
  /**
   * Runs right before a rollback; tests change the folder here to reach a
   * rollback that fails, or stop the restore there as a crash would.
   */
  beforeRollback?: () => Promise<void> | void;
  /** One line in the holder's log; never given a path or a file name. */
  log: (line: string) => void;
};

/** Whether every stored file the restore writes still has its content. */
const verifyNeeded = async (
  store: string,
  desired: ReadonlyMap<string, Entry>,
  existing: ReadonlyMap<string, Entry>,
) =>
  await Result.tryPromise({
    try: async () => {
      for (const entry of desired.values()) {
        const now = existing.get(entry.path);
        if (
          entry.kind === "file" &&
          !(now?.kind === "file" && now.sha256 === entry.sha256) &&
          // await-in-loop: one stored file in memory at a time.
          !(await verifyObject(store, entry))
        ) {
          return false;
        }
      }
      return true;
    },
    catch: restoreFailed("A saved file could not be read."),
  });

const byEntryPath = (entries: readonly Entry[]) =>
  new Map(entries.map((entry) => [entry.path, entry]));

/**
 * Put the folder back as it was saved before the restore began, and check
 * that a new walk finds exactly that.
 */
const rollBack = async (
  workspaceDir: string,
  store: string,
  saved: readonly Entry[],
  limits: CheckpointLimits,
): Promise<Result<void, CheckpointRefused | CheckpointRestoreFailed>> =>
  await Result.gen(async function* () {
    const now = yield* Result.await(
      saveTree({ workspaceDir, store, limits, known: saved }),
    );
    yield* Result.await(
      applyTree(workspaceDir, store, byEntryPath(saved), byEntryPath(now)),
    );
    const after = yield* Result.await(
      saveTree({ workspaceDir, store, limits, known: saved }),
    );
    return sameTree(after, saved)
      ? Result.ok()
      : Result.err(
          restoreFailed("The folder did not come back as it was saved.")(),
        );
  });

const dropRecovery = async (file: string) =>
  await Result.tryPromise({
    try: async () => {
      await rm(file, { force: true });
    },
    catch: refused("failed", "A settled restore's state could not be removed."),
  });

/**
 * Settle a restore that was interrupted (the holder stopped mid-way): a
 * recovery record left in the store means the folder may be half restored.
 * The folder is put back to the newest record, the same way a failed restore
 * rolls back, and the records are dropped. Runs first, with the store held.
 */
const reconcile = async (
  store: string,
  workspaceDir: string,
  limits: CheckpointLimits,
): Promise<Result<void, CheckpointRefused | CheckpointRestoreFailed>> =>
  await Result.gen(async function* () {
    const texts = yield* Result.await(
      readTexts(path.join(store, RECOVERY), limits.maxManifestBytes),
    );
    const records = texts
      .flatMap(({ file, text }) => {
        const recovery = parsedAs(recoverySchema, text);
        return recovery === null ? [] : [{ file, recovery }];
      })
      .toSorted((left, right) =>
        left.recovery.savedAt < right.recovery.savedAt ? -1 : 1,
      );
    const newest = records.at(-1);
    if (newest === undefined) {
      return Result.ok();
    }
    yield* Result.await(
      rollBack(workspaceDir, store, newest.recovery.entries, limits),
    );
    for (const { file } of records) {
      // await-in-loop: removals one at a time.
      yield* Result.await(dropRecovery(file));
    }
    return Result.ok();
  });

/**
 * Put the folder back as the run's checkpoint saved it. Only the newest
 * checkpoint not undone yet is restored. The folder's current state is saved
 * and written down first; any failure puts it back. Until the folder is
 * restored or verifiably put back, that state and its files stay in the
 * store.
 *
 * The caller holds the store, and makes sure no run uses the folder.
 */
const restoreHeld = async (
  store: string,
  { workspaceDir, runId, beforeRollback }: RestoreOptions,
  limits: CheckpointLimits,
): Promise<CheckpointRestore> => {
  const state = await readStore(store, limits);
  if (Result.isError(state)) {
    return {
      outcome: "failed",
      detail: "the checkpoint store could not be read",
    };
  }
  const { manifests } = state.value;
  const target = manifests.find((manifest) => manifest.runId === runId);
  if (target === undefined) {
    return { outcome: "no_checkpoint", detail: null };
  }
  const newest = manifests.findLast(({ undone }) => !undone);
  if (newest?.runId !== runId) {
    return { outcome: "not_newest", detail: null };
  }
  const desired = desiredTree(
    target,
    manifests.filter(({ ordinal }) => ordinal > target.ordinal),
  );
  const saved = await saveTree({
    workspaceDir,
    store,
    limits,
    known: manifests.at(-1)?.entries ?? [],
  });
  if (Result.isError(saved)) {
    return {
      outcome: "failed",
      detail: `the folder could not be saved first: ${saved.error.reason}`,
    };
  }
  const recoveryFile = path.join(
    store,
    RECOVERY,
    `${crypto.randomUUID()}.json`,
  );
  const recovery: Recovery = {
    version: MANIFEST_VERSION,
    restoreOf: runId,
    savedAt: Temporal.Now.instant().toString(),
    entries: saved.value,
  };
  const recorded = await writeJson(
    recoveryFile,
    recovery,
    limits.maxManifestBytes,
  );
  if (Result.isError(recorded)) {
    return {
      outcome: "failed",
      detail: "the folder's current state could not be written down",
    };
  }
  const before = byEntryPath(saved.value);
  const verified = await verifyNeeded(store, desired, before);
  if (Result.isError(verified) || !verified.value) {
    const dropped = await dropRecovery(recoveryFile);
    return {
      outcome: "failed",
      detail: Result.isOk(dropped)
        ? "a saved file is missing or changed"
        : "a saved file is missing or changed; the state before was kept",
    };
  }
  const applied = await applyTree(workspaceDir, store, desired, before);
  // Marked undone in the same step: a restore that is not recorded did not
  // happen, and is undone too.
  const marked =
    Result.isOk(applied) &&
    Result.isOk(
      await writeManifest(store, { ...target, undone: true }, limits),
    );
  if (marked) {
    const dropped = await dropRecovery(recoveryFile);
    return {
      outcome: "restored",
      detail: Result.isOk(dropped)
        ? null
        : "the state before the restore was kept",
    };
  }
  await beforeRollback?.();
  const rolledBack = await rollBack(workspaceDir, store, saved.value, limits);
  if (Result.isOk(rolledBack)) {
    const dropped = await dropRecovery(recoveryFile);
    return {
      outcome: "failed",
      detail: Result.isOk(dropped)
        ? "the restore failed and the folder was put back"
        : "the restore failed and the folder was put back; the state before was kept",
    };
  }
  return {
    outcome: "failed",
    detail:
      "the restore failed and the folder could not be put back; the state before was kept",
  };
};

/**
 * Restore the run's checkpoint with the store to itself, then remove the
 * stored files nothing names any more. Answered whatever fails.
 */
export const restoreCheckpoint = async (
  options: RestoreOptions,
): Promise<CheckpointRestore> => {
  const limits = options.limits ?? CHECKPOINT_LIMITS;
  const store = checkpointStoreOf(options.workspaceDir);
  const found = Result.try({
    try: () => entryAt(store)?.isDirectory() === true,
    catch: refused("failed", "The checkpoint store could not be read."),
  });
  if (Result.isError(found)) {
    return {
      outcome: "failed",
      detail: "the checkpoint store could not be read",
    };
  }
  if (!found.value) {
    return { outcome: "no_checkpoint", detail: null };
  }
  const restored = await withStore(store, limits, options.log, async () => {
    // An interrupted restore is settled first; until it is, nothing else.
    const settled = await reconcile(store, options.workspaceDir, limits);
    if (Result.isError(settled)) {
      const unsettled: CheckpointRestore = {
        outcome: "failed",
        detail: "an interrupted restore could not be settled",
      };
      return Result.ok(unsettled);
    }
    const outcome = await restoreHeld(store, options, limits);
    // A store that cannot be read removes nothing.
    const collected = await Result.gen(async function* () {
      const state = yield* Result.await(readStore(store, limits));
      return await collectGarbage(store, state.manifests, state.recoveries);
    });
    return Result.ok(
      Result.isOk(collected) || outcome.detail !== null
        ? outcome
        : { ...outcome, detail: "files the restore no longer needs were kept" },
    );
  });
  return Result.isOk(restored)
    ? restored.value
    : { outcome: "failed", detail: "the checkpoint store could not be held" };
};

type CaptureOptions = {
  workspaceDir: string;
  runId: string;
  /** Attachment paths copied into the folder for this run. */
  memberFiles: readonly string[];
  /**
   * Folders the run uses and never owns: skill folders, the package cache,
   * the CLI's home. A run folder holding one, or inside one, is not saved.
   */
  protectedPaths: readonly string[];
  /** Ends a capture in progress when the run is stopped. */
  signal?: AbortSignal;
  limits?: CheckpointLimits;
  /** One line in the holder's log; never given a path or a file name. */
  log: (line: string) => void;
};

/**
 * Save the run's folder as it stands. Past any bound, nothing is saved and
 * the reason is reported: the turn runs either way, without an undo.
 */
export const captureCheckpoint = async ({
  workspaceDir,
  runId,
  memberFiles,
  protectedPaths,
  signal,
  limits = CHECKPOINT_LIMITS,
  log,
}: CaptureOptions): Promise<DesktopRunnerCheckpointEvent> => {
  if (
    protectedPaths.some(
      (protectedPath) =>
        contains(workspaceDir, protectedPath) ||
        contains(protectedPath, workspaceDir),
    )
  ) {
    return { status: "unavailable", reason: "unsupported" };
  }
  const store = checkpointStoreOf(workspaceDir);
  const taken = await withStore(store, limits, log, async () => {
    // An interrupted restore is settled first; until it is, nothing else.
    const settled = await reconcile(store, workspaceDir, limits);
    if (Result.isError(settled)) {
      log(`an interrupted restore was not settled: ${settled.error.message}`);
      return Result.err(
        refused("failed", "An interrupted restore was not settled.")(),
      );
    }
    const saved = await Result.gen(async function* () {
      const { manifests } = yield* Result.await(readStore(store, limits));
      const latest = manifests.at(-1);
      const entries = yield* Result.await(
        saveTree({
          workspaceDir,
          store,
          limits,
          known: latest?.entries ?? [],
          signal,
        }),
      );
      const files = new Set(
        entries.flatMap((entry) => (entry.kind === "file" ? [entry.path] : [])),
      );
      return await writeManifest(
        store,
        {
          version: MANIFEST_VERSION,
          runId,
          ordinal: (latest?.ordinal ?? 0) + 1,
          takenAt: Temporal.Now.instant().toString(),
          undone: false,
          entries,
          memberFiles: memberFiles.filter((memberFile) =>
            files.has(memberFile),
          ),
        },
        limits,
      );
    });
    // Also after a refusal: files stored before it are named by nothing.
    const pruned = await prune(store, limits);
    if (Result.isError(pruned)) {
      log(`older checkpoints were kept: ${pruned.error.message}`);
    }
    return saved;
  });
  return Result.isOk(taken)
    ? { status: "taken" }
    : { status: "unavailable", reason: taken.error.reason };
};

/** A capture's report as the chunk it travels in on the run's stream. */
export const checkpointChunk = (
  value: DesktopRunnerCheckpointEvent,
  timestamp: number,
) =>
  ({
    type: EventType.CUSTOM,
    name: DESKTOP_RUNNER_CHECKPOINT_EVENT,
    value,
    timestamp,
  }) as const;
