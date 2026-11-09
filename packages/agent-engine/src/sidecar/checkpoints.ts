import { EventType } from "@tanstack/ai";
import { Result, TaggedError } from "better-result";
import { lstatSync, type Stats } from "node:fs";
import {
  chmod,
  constants,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_CHECKPOINT_EVENT,
  type DESKTOP_RUNNER_CHECKPOINT_UNAVAILABLE_REASONS,
  type DesktopRunnerCheckpointEvent,
} from "@stll/api-contract/desktop-runner";
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
 * folder's entries (`manifests/<runId>.json`), written last.
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
};

export const CHECKPOINT_LIMITS: CheckpointLimits = {
  maxEntries: 5000,
  maxDepth: 8,
  maxFileBytes: 256 * 1024 * 1024,
  maxNewBytes: 1024 * 1024 * 1024,
  maxCaptureMs: 15_000,
  maxManifests: 20,
  maxStoredBytes: 2 * 1024 * 1024 * 1024,
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
const MANIFEST_VERSION = 1;
/** A manifest of the largest folder a capture saves is well below this. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
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

type StoredManifests = {
  /** Readable manifests, oldest first. */
  manifests: Manifest[];
  /** Files in the manifest folder that are not one. */
  unreadable: string[];
};

const readManifests = async (store: string): Promise<StoredManifests> => {
  const folder = path.join(store, MANIFESTS);
  const names = await namesIn(folder);
  const manifests: Manifest[] = [];
  const unreadable: string[] = [];
  for (const name of names.toSorted()) {
    const file = path.join(folder, name);
    // await-in-loop: one manifest in memory at a time.
    const read = await Result.tryPromise(async () => {
      const handle = await open(file, READ_FLAGS);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
          return null;
        }
        return await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }
    });
    const text = Result.isOk(read) ? read.value : null;
    const json =
      text === null ? null : Result.try((): unknown => JSON.parse(text));
    const parsed =
      json !== null && Result.isOk(json)
        ? v.safeParse(manifestSchema, json.value)
        : null;
    if (parsed?.success === true && name === `${parsed.output.runId}.json`) {
      manifests.push(parsed.output);
    } else {
      unreadable.push(file);
    }
  }
  return {
    manifests: manifests.toSorted(
      (left, right) => left.ordinal - right.ordinal,
    ),
    unreadable,
  };
};

/** Written to a fresh name, flushed, then renamed: a manifest is whole or absent. */
const writeManifest = async (store: string, manifest: Manifest) =>
  await Result.tryPromise({
    try: async () => {
      const temp = path.join(
        store,
        MANIFESTS,
        `.${TEMP_OBJECT_PREFIX}${crypto.randomUUID()}`,
      );
      try {
        const handle = await open(temp, CREATE_FLAGS, PRIVATE_FILE_MODE);
        try {
          await handle.writeFile(JSON.stringify(manifest));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, manifestPath(store, manifest.runId));
      } finally {
        await rm(temp, { force: true });
      }
    },
    catch: refused("failed", "The checkpoint could not be written."),
  });

const storedBytes = (manifests: readonly Manifest[]) => {
  const sizes = new Map<string, number>();
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (entry.kind === "file") {
        sizes.set(entry.sha256, entry.size);
      }
    }
  }
  return [...sizes.values()].reduce((total, size) => total + size, 0);
};

/** Remove every stored file no kept manifest names, and stale temp files. */
const collectGarbage = async (store: string, kept: readonly Manifest[]) => {
  const referenced = new Set(
    kept.flatMap((manifest) =>
      manifest.entries.flatMap((entry) =>
        entry.kind === "file" ? [entry.sha256] : [],
      ),
    ),
  );
  const objects = path.join(store, OBJECTS);
  const buckets = await namesIn(objects);
  for (const bucket of buckets) {
    const folder = path.join(objects, bucket);
    if (bucket.startsWith(TEMP_OBJECT_PREFIX)) {
      // await-in-loop: removals one at a time.
      await rm(folder, { force: true });
      continue;
    }
    // await-in-loop: one bucket listed at a time.
    const names = await namesIn(folder);
    for (const name of names) {
      if (!referenced.has(name)) {
        // await-in-loop: removals one at a time.
        await rm(path.join(folder, name), { force: true });
      }
    }
  }
};

/**
 * Keep the newest checkpoints within the folder's bounds: oldest first, never
 * the newest; then remove what no kept checkpoint names.
 */
const prune = async (store: string, limits: CheckpointLimits) =>
  await Result.tryPromise(async () => {
    const { manifests, unreadable } = await readManifests(store);
    for (const file of unreadable) {
      // await-in-loop: removals one at a time.
      await rm(file, { force: true });
    }
    const kept = manifests.slice(-Math.max(1, limits.maxManifests));
    while (kept.length > 1 && storedBytes(kept) > limits.maxStoredBytes) {
      kept.shift();
    }
    const keptIds = new Set(kept.map(({ runId }) => runId));
    for (const manifest of manifests) {
      if (!keptIds.has(manifest.runId)) {
        // await-in-loop: removals one at a time.
        await rm(manifestPath(store, manifest.runId), { force: true });
      }
    }
    await collectGarbage(store, kept);
  });

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
  const taken = await Result.gen(async function* () {
    yield* Result.await(openStore(store));
    const { manifests } = yield* Result.await(
      Result.tryPromise({
        try: async () => await readManifests(store),
        catch: refused("failed", "The checkpoints could not be read."),
      }),
    );
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
    const saved = new Set(
      entries.flatMap((entry) => (entry.kind === "file" ? [entry.path] : [])),
    );
    yield* Result.await(
      writeManifest(store, {
        version: MANIFEST_VERSION,
        runId,
        ordinal: (latest?.ordinal ?? 0) + 1,
        takenAt: Temporal.Now.instant().toString(),
        undone: false,
        entries,
        memberFiles: memberFiles.filter((memberFile) => saved.has(memberFile)),
      }),
    );
    return Result.ok();
  });
  // Also after a refusal: files stored before it are named by nothing.
  const pruned = await prune(store, limits);
  if (Result.isError(pruned)) {
    log("older checkpoints could not be removed");
  }
  return Result.isOk(taken)
    ? { status: "taken" }
    : { status: "unavailable", reason: taken.error.reason };
};

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
        if (
          entry.kind === "dir" &&
          (now?.kind !== "dir" || now.mode !== entry.mode)
        ) {
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

/**
 * Put the folder back as the run's checkpoint saved it. Only the newest
 * checkpoint not undone yet is restored. The folder's current state is saved
 * first: any failure puts that back, and the restore reports `failed`.
 *
 * The caller makes sure no run uses the folder meanwhile.
 */
const restoreFromStore = async ({
  workspaceDir,
  runId,
  limits = CHECKPOINT_LIMITS,
}: RestoreOptions): Promise<CheckpointRestore> => {
  const store = checkpointStoreOf(workspaceDir);
  const storeEntry = entryAt(store);
  if (storeEntry?.isDirectory() !== true) {
    return { outcome: "no_checkpoint", detail: null };
  }
  const { manifests } = await readManifests(store);
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
  const outcome = await (async (): Promise<CheckpointRestore> => {
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
    const before = new Map(saved.value.map((entry) => [entry.path, entry]));
    const verified = await verifyNeeded(store, desired, before);
    if (Result.isError(verified) || !verified.value) {
      return {
        outcome: "failed",
        detail: "a saved file is missing or changed",
      };
    }
    const applied = await applyTree(workspaceDir, store, desired, before);
    // Marked undone in the same step: a restore that is not recorded did
    // not happen, and is undone too.
    const marked =
      Result.isOk(applied) &&
      Result.isOk(await writeManifest(store, { ...target, undone: true }));
    if (marked) {
      return { outcome: "restored", detail: null };
    }
    // Back to the state saved before the restore began.
    const now = await saveTree({
      workspaceDir,
      store,
      limits,
      known: saved.value,
    });
    const rolledBack =
      Result.isOk(now) &&
      Result.isOk(
        await applyTree(
          workspaceDir,
          store,
          before,
          new Map(now.value.map((entry) => [entry.path, entry])),
        ),
      );
    return {
      outcome: "failed",
      detail: rolledBack
        ? "the restore failed and the folder was put back"
        : "the restore failed and the folder could not be put back",
    };
  })();
  // The state saved before the restore is named by no checkpoint.
  const collected = await Result.tryPromise(async () => {
    await collectGarbage(store, (await readManifests(store)).manifests);
  });
  return Result.isOk(collected) || outcome.detail !== null
    ? outcome
    : { ...outcome, detail: "files the restore no longer needs were kept" };
};

export const restoreCheckpoint = async (
  options: RestoreOptions,
): Promise<CheckpointRestore> => {
  // Reading the store fails before anything in the folder moves; the restore
  // is answered either way.
  const restored = await Result.tryPromise(
    async () => await restoreFromStore(options),
  );
  return Result.isOk(restored)
    ? restored.value
    : { outcome: "failed", detail: "the checkpoint store could not be read" };
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
