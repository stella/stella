// Records every file-system question a TypeScript program asks while it is
// built (file reads, existence probes, real paths, directory entries) and
// replays them later. When every answer is unchanged, the program would load
// exactly the same files with exactly the same bytes, so anything derived only
// from it is still current. Replaying costs some thousands of stat calls and
// file hashes instead of a full parse and type check.
import { Result } from "better-result";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileSystem, FileSystemEntries } from "typescript/unstable/fs";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";
import { createSha256, sha256Hex } from "@stll/sha256/bun";

const pathListSchema = v.array(v.string());
// A directory's file and subdirectory names, as the compiler lists them.
const entriesSchema = v.strictObject({
  files: pathListSchema,
  directories: pathListSchema,
});
const existenceSchema = v.strictObject({
  present: pathListSchema,
  absent: pathListSchema,
});

export const compilerInputStampSchema = v.strictObject({
  context: v.string(),
  // Content hash per file read; null when the read found no file.
  contents: v.record(v.string(), v.nullable(v.string())),
  // Installed dependency files: size and modification time. Installs write
  // them; nothing edits them in place.
  installed: v.record(v.string(), v.nullable(v.string())),
  files: existenceSchema,
  directories: existenceSchema,
  realpaths: v.record(v.string(), v.string()),
  entries: v.record(v.string(), entriesSchema),
});

export type CompilerInputStamp = v.InferOutput<typeof compilerInputStampSchema>;

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

const readBytes = (fileName: string): Buffer | undefined => {
  const read = Result.try(() => readFileSync(fileName));
  return read.isOk() ? read.value : undefined;
};

const contentHash = (bytes: Buffer | undefined) =>
  bytes === undefined ? null : sha256Hex(bytes);

const installedFingerprint = (
  stats: { size: number; mtimeMs: number; isFile: () => boolean } | undefined,
) =>
  stats === undefined || !stats.isFile()
    ? null
    : `${stats.size}:${stats.mtimeMs}`;

// As the compiler reads a file: a byte order mark selects the encoding and is
// not part of the text.
const decodeSource = (bytes: Buffer): string => {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString("utf16le", 2);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.toString("utf-8", 3);
  }
  return bytes.toString("utf-8");
};

const EMPTY_ENTRIES: FileSystemEntries = { files: [], directories: [] };

/**
 * A directory's entries as the compiler sees them: names only, a symbolic link
 * counted as what it points at, sorted. Unreadable directories have none.
 */
const accessibleEntries = (directory: string): FileSystemEntries => {
  const listed = Result.try(() =>
    readdirSync(directory, { withFileTypes: true }),
  );
  if (listed.isErr()) {
    return EMPTY_ENTRIES;
  }
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of listed.value) {
    const target = entry.isSymbolicLink()
      ? Result.try(() =>
          statSync(path.join(directory, entry.name), { throwIfNoEntry: false }),
        ).unwrapOr(undefined)
      : entry;
    if (target?.isFile() === true) {
      files.push(entry.name);
    } else if (target?.isDirectory() === true) {
      directories.push(entry.name);
    }
  }
  return { files: files.toSorted(), directories: directories.toSorted() };
};

const isFileOnDisk = (fileName: string) =>
  statSync(fileName, { throwIfNoEntry: false })?.isFile() === true;

const isDirectoryOnDisk = (directory: string) =>
  statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true;

const realpathOnDisk = (fileName: string) =>
  Result.try(() => realpathSync(fileName)).unwrapOr(fileName);

export type CompilerInputRecorder = {
  /**
   * The file system a TypeScript 7 program is built on: every question is
   * answered from disk and recorded, except for `virtualFiles`, which are
   * served from memory and never recorded.
   */
  fileSystem: (virtualFiles?: ReadonlyMap<string, string>) => FileSystem;
  /** Records a file the caller reads outside the compiler. */
  readFile: (fileName: string) => string | undefined;
  stamp: (context: string) => CompilerInputStamp;
  /**
   * The same answers for another checkout or machine: installed files are
   * compared by content (another install writes them with other times) and
   * paths under `root` are stored relative to it (see toPortableStamp).
   */
  portableStamp: (context: string, root: string) => CompilerInputStamp;
};

// Stands for the checkout root, or its real path, in a portable stamp. Real
// paths leave the root's spelling when it is reached through a symbolic link
// (macOS /var and /tmp are), so they move with the real root instead. Tokens
// deliberately omit directory depth: the same repository tree can be restored
// into a checkout nested under a different number of parent directories.
const ROOT_TOKEN_PATTERN = /<(?:real-)?root>/gu;
const ROOT_TOKEN = "<root>";
const REAL_ROOT_TOKEN = "<real-root>";

// Module resolution walks up from the root: each ancestor's node_modules and
// package.json scope. Those probes follow the checkout to its new parents;
// any other path outside the root names the same file everywhere.
const isAncestorWalkProbe = (fromAncestor: string) =>
  fromAncestor === "" ||
  fromAncestor === "package.json" ||
  fromAncestor === "node_modules" ||
  fromAncestor.startsWith("node_modules/");

const toPortablePath = (value: string, base: string, token: string) => {
  // A relative name is an answer, not a path to resolve against the
  // generator's current working directory.
  if (!path.isAbsolute(value)) {
    return value;
  }
  const relative = repoRelativePath(base, value);
  if (relative === "") {
    return token;
  }
  if (relative !== ".." && !relative.startsWith("../")) {
    return `${token}/${relative}`;
  }
  const fromAncestor = relative.replace(/^(?:\.\.(?:\/|$))+/u, "");
  return isAncestorWalkProbe(fromAncestor) ? `${token}/${relative}` : value;
};

const toLocalPath = (value: string, token: string, base: string) => {
  if (value === token) {
    return base;
  }
  return value.startsWith(`${token}/`)
    ? path.join(base, value.slice(token.length + 1))
    : value;
};

/** Rewrites every path in a stamp with `move`. */
const relocateStamp = (
  stamp: CompilerInputStamp,
  move: (value: string) => string,
): CompilerInputStamp => {
  const moveList = (values: readonly string[]) => values.map(move);
  const moveKeys = <Value>(
    record: Record<string, Value>,
    moveValue: (value: Value) => Value,
  ) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        move(key),
        moveValue(value),
      ]),
    );
  const keep = <Value>(value: Value) => value;
  return {
    context: stamp.context,
    contents: moveKeys(stamp.contents, keep),
    installed: moveKeys(stamp.installed, keep),
    files: {
      present: moveList(stamp.files.present),
      absent: moveList(stamp.files.absent),
    },
    directories: {
      present: moveList(stamp.directories.present),
      absent: moveList(stamp.directories.absent),
    },
    realpaths: moveKeys(stamp.realpaths, move),
    // Entry names are relative to their directory and stay as they are.
    entries: moveKeys(stamp.entries, keep),
  };
};

/**
 * Stores the paths under a checkout `root`, and the probes module resolution
 * makes in its ancestors, relative to it.
 */
const toPortableStamp = (stamp: CompilerInputStamp, root: string) => {
  const realRoot = realpathSync(root);
  return relocateStamp(stamp, (value) => {
    const portable = toPortablePath(value, root, ROOT_TOKEN);
    return portable === value
      ? toPortablePath(value, realRoot, REAL_ROOT_TOKEN)
      : portable;
  });
};

/**
 * Places a portable stamp's repository-relative paths under checkout `root`.
 * Absolute paths remain untouched, so a machine-specific path outside the
 * repository never matches another checkout.
 */
const localizeStampOrThrow = (stamp: CompilerInputStamp, root: string) => {
  const realRoot = realpathSync(root);
  const tokens = JSON.stringify(stamp).match(ROOT_TOKEN_PATTERN) ?? [];
  if (
    tokens.some((found) => found !== ROOT_TOKEN && found !== REAL_ROOT_TOKEN)
  ) {
    return undefined;
  }
  const localized = relocateStamp(stamp, (value) =>
    toLocalPath(
      toLocalPath(value, REAL_ROOT_TOKEN, realRoot),
      ROOT_TOKEN,
      root,
    ),
  );
  if (tokens.length === 0) {
    return localized;
  }

  const recorded = new Set<string>();
  const record = (value: string) => {
    if (path.isAbsolute(value)) {
      recorded.add(path.resolve(value));
    }
  };
  for (const value of [
    ...Object.keys(localized.contents),
    ...Object.keys(localized.installed),
    ...localized.files.present,
    ...localized.files.absent,
    ...localized.directories.present,
    ...localized.directories.absent,
    ...Object.keys(localized.realpaths),
    ...Object.keys(localized.entries),
  ]) {
    record(value);
  }

  // A stamp made elsewhere cannot describe destination-only ancestors. An
  // unrecorded package scope or dependency directory there could turn a
  // formerly unresolved import into a different program. TypeScript probes
  // the checkout's literal path as well as its resolved one, so a checkout
  // reached through a symlink has two ancestor chains.
  for (const start of new Set([path.resolve(root), realRoot])) {
    for (
      let ancestor = path.dirname(start);
      ;
      ancestor = path.dirname(ancestor)
    ) {
      for (const candidate of [
        path.join(ancestor, "node_modules"),
        path.join(ancestor, "package.json"),
      ]) {
        if (
          !recorded.has(candidate) &&
          statSync(candidate, { throwIfNoEntry: false }) !== undefined
        ) {
          return undefined;
        }
      }
      if (path.dirname(ancestor) === ancestor) {
        break;
      }
    }
  }
  return localized;
};

/**
 * {@link localizeStampOrThrow}, treating an unreadable checkout or ancestor as
 * a stamp that cannot be reused, so the caller generates instead of failing.
 */
export const localizeStamp = (stamp: CompilerInputStamp, root: string) => {
  const localized = Result.try(() => localizeStampOrThrow(stamp, root));
  return localized.isOk() ? localized.value : undefined;
};

// Paths and keys, not text: a stable code-unit order on every machine.
const compareKeys = (left: string, right: string) =>
  left < right ? -1 : Number(left > right);

const sortedRecord = <Value>(entries: Map<string, Value>) =>
  Object.fromEntries(
    [...entries].toSorted(([left], [right]) => compareKeys(left, right)),
  );

const existence = (answers: Map<string, boolean>) => {
  const present: string[] = [];
  const absent: string[] = [];
  for (const [fileName, exists] of answers) {
    (exists ? present : absent).push(fileName);
  }
  return { present: present.toSorted(), absent: absent.toSorted() };
};

// Every directory that holds a virtual file, so resolution can reach it.
const virtualDirectoriesOf = (virtualFiles: ReadonlyMap<string, string>) => {
  const directories = new Map<string, FileSystemEntries>();
  const entriesOf = (directory: string) => {
    const known = directories.get(directory);
    if (known !== undefined) {
      return known;
    }
    const created: FileSystemEntries = { files: [], directories: [] };
    directories.set(directory, created);
    return created;
  };
  for (const fileName of virtualFiles.keys()) {
    entriesOf(path.dirname(fileName)).files.push(path.basename(fileName));
    for (
      let directory = path.dirname(fileName);
      path.dirname(directory) !== directory;
      directory = path.dirname(directory)
    ) {
      const siblings = entriesOf(path.dirname(directory)).directories;
      const name = path.basename(directory);
      if (siblings.includes(name)) {
        break;
      }
      siblings.push(name);
    }
  }
  return directories;
};

const mergeEntries = (
  real: FileSystemEntries,
  virtual: FileSystemEntries | undefined,
): FileSystemEntries =>
  virtual === undefined
    ? real
    : {
        files: [...new Set([...real.files, ...virtual.files])].toSorted(),
        directories: [
          ...new Set([...real.directories, ...virtual.directories]),
        ].toSorted(),
      };

/**
 * The file system for a program built without recording: `virtualFiles` from
 * memory, everything else read by the compiler itself.
 */
export const serveVirtualFiles = (
  virtualFiles: ReadonlyMap<string, string>,
): FileSystem => {
  const virtualDirectories = virtualDirectoriesOf(virtualFiles);
  return {
    readFile: (fileName) => virtualFiles.get(fileName),
    fileExists: (fileName) => (virtualFiles.has(fileName) ? true : undefined),
    directoryExists: (directory) =>
      virtualDirectories.has(directory) ? true : undefined,
    realpath: (fileName) => (virtualFiles.has(fileName) ? fileName : undefined),
    getAccessibleEntries: (directory) => {
      const virtual = virtualDirectories.get(directory);
      return virtual === undefined
        ? undefined
        : mergeEntries(accessibleEntries(directory), virtual);
    },
  };
};

export const createCompilerInputRecorder = (): CompilerInputRecorder => {
  const contents = new Map<string, string | null>();
  const installed = new Map<string, string | null>();
  const installedContents = new Map<string, string | null>();
  const files = new Map<string, boolean>();
  const directories = new Map<string, boolean>();
  const realpaths = new Map<string, string>();
  const entries = new Map<string, FileSystemEntries>();
  // Reads the bytes once and hands the compiler that text, so the recorded
  // hash is of the bytes it parsed even if the file changes while the program
  // is built.
  const recordRead = (fileName: string) => {
    const bytes = readBytes(fileName);
    if (fileName.includes(NODE_MODULES)) {
      installed.set(
        fileName,
        bytes === undefined
          ? null
          : installedFingerprint(statSync(fileName, { throwIfNoEntry: false })),
      );
      installedContents.set(fileName, contentHash(bytes));
    } else {
      contents.set(fileName, contentHash(bytes));
    }
    return bytes === undefined ? undefined : decodeSource(bytes);
  };
  const fileSystem = (
    virtualFiles: ReadonlyMap<string, string> = new Map(),
  ): FileSystem => {
    const virtualDirectories = virtualDirectoriesOf(virtualFiles);
    return {
      readFile: (fileName) =>
        virtualFiles.get(fileName) ?? recordRead(fileName) ?? null,
      fileExists: (fileName) => {
        if (virtualFiles.has(fileName)) {
          return true;
        }
        const exists = isFileOnDisk(fileName);
        files.set(fileName, exists);
        return exists;
      },
      directoryExists: (directory) => {
        if (virtualDirectories.has(directory)) {
          return true;
        }
        const exists = isDirectoryOnDisk(directory);
        directories.set(directory, exists);
        return exists;
      },
      realpath: (fileName) => {
        if (virtualFiles.has(fileName)) {
          return fileName;
        }
        const real = realpathOnDisk(fileName);
        realpaths.set(fileName, real);
        return real;
      },
      getAccessibleEntries: (directory) => {
        const found = accessibleEntries(directory);
        entries.set(directory, found);
        return mergeEntries(found, virtualDirectories.get(directory));
      },
    };
  };
  const stamp = (
    context: string,
    contentsOf: Map<string, string | null>,
    installedOf: Map<string, string | null>,
  ): CompilerInputStamp => ({
    context,
    contents: sortedRecord(contentsOf),
    installed: sortedRecord(installedOf),
    files: existence(files),
    directories: existence(directories),
    realpaths: sortedRecord(realpaths),
    entries: sortedRecord(
      new Map(
        [...entries].map(([directory, found]) => [
          directory,
          { files: [...found.files], directories: [...found.directories] },
        ]),
      ),
    ),
  });
  return {
    fileSystem,
    readFile: recordRead,
    stamp: (context) => stamp(context, contents, installed),
    portableStamp: (context, root) =>
      toPortableStamp(
        stamp(context, new Map([...contents, ...installedContents]), new Map()),
        root,
      ),
  };
};

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const statOrUndefined = (fileName: string) =>
  statSync(fileName, { throwIfNoEntry: false });

type Check = () => boolean | Promise<boolean>;

// The same answers the recording file system gave. Reads and real paths are
// asked concurrently so the file system can overlap the I/O; stat calls are
// cheap enough inline.
function* checks(stamp: CompilerInputStamp): Generator<Check> {
  for (const [fileName, hash] of Object.entries(stamp.contents)) {
    yield async () => {
      const read = await Result.tryPromise(
        async () => await readFile(fileName),
      );
      return (read.isOk() ? sha256Hex(read.value) : null) === hash;
    };
  }
  for (const [fileName, fingerprint] of Object.entries(stamp.installed)) {
    yield () => installedFingerprint(statOrUndefined(fileName)) === fingerprint;
  }
  for (const [{ present, absent }, matches] of [
    [stamp.files, (found: Stats) => found.isFile()],
    [stamp.directories, (found: Stats) => found.isDirectory()],
  ] as const) {
    for (const fileName of present) {
      yield () => {
        const found = statOrUndefined(fileName);
        return found !== undefined && matches(found);
      };
    }
    for (const fileName of absent) {
      yield () => {
        const found = statOrUndefined(fileName);
        return found === undefined || !matches(found);
      };
    }
  }
  for (const [fileName, real] of Object.entries(stamp.realpaths)) {
    yield async () => {
      const resolved = await Result.tryPromise(
        async () => await realpath(fileName),
      );
      return (resolved.isOk() ? resolved.value : fileName) === real;
    };
  }
  for (const [directory, found] of Object.entries(stamp.entries)) {
    yield () => {
      const current = accessibleEntries(directory);
      return (
        sameStrings(current.files, found.files) &&
        sameStrings(current.directories, found.directories)
      );
    };
  }
}

const CONCURRENCY = 64;

/**
 * Whether a stamp still describes the file system: same context and the same
 * answer to every recorded question. Stops at the first difference.
 */
export const isCompilerInputStampCurrent = async (
  stamp: CompilerInputStamp,
  context: string,
): Promise<boolean> => {
  if (stamp.context !== context) {
    return false;
  }
  const pending = checks(stamp);
  let current = true;
  const worker = async () => {
    for (const check of pending) {
      if (!current) {
        return;
      }
      if (!(await check())) {
        current = false;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return current;
};

const scriptImports = new Bun.Transpiler({ loader: "ts" });

/**
 * Hashes the relative and workspace import closure of a script: the modules
 * it runs, so a type-only import, which runs nothing, is not part of it.
 */
export const scriptSourceHash = (entry: string): string => {
  const hash = createSha256();
  // Names relative to the entry: checkouts at other paths hash alike. Real
  // paths, since resolution returns them for the imports.
  const realEntry = realpathSync(entry);
  const base = path.dirname(realEntry);
  const pending = [realEntry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    hash.update(
      JSON.stringify([repoRelativePath(base, file), sha256Hex(source)]),
    );
    for (const { path: specifier } of scriptImports.scanImports(source)) {
      if (specifier.startsWith(".") || specifier.startsWith("@stll/")) {
        pending.push(Bun.resolveSync(specifier, path.dirname(file)));
      }
    }
  }
  return hash.digest("hex");
};
