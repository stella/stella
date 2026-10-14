// Records every file-system question a TypeScript program asks while it is
// built (file reads, existence probes, real paths, directory listings) and
// replays them later. When every answer is unchanged, the program would load
// exactly the same files with exactly the same bytes, so anything derived only
// from it is still current. Replaying costs some thousands of stat calls and
// file hashes instead of a full parse and type check.
import { Result } from "better-result";
import { type Stats, readFileSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { createSha256, sha256Hex } from "@stll/sha256/bun";

const pathListSchema = v.array(v.string());
// JSON has no undefined: an omitted readDirectory argument is stored as null.
const readDirectorySchema = v.tuple([
  v.tuple([
    v.string(),
    v.nullable(pathListSchema),
    v.nullable(pathListSchema),
    v.nullable(pathListSchema),
    v.nullable(v.number()),
  ]),
  pathListSchema,
]);
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
  subdirectories: v.record(v.string(), pathListSchema),
  listings: v.array(readDirectorySchema),
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

// Matches ts.sys.readFile: a byte order mark selects the encoding and is not
// part of the text.
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

// Both the config-file host and the compiler host satisfy this: the listing
// and read signatures follow ParseConfigFileHost, whose readonly results the
// compiler host's mutable ones also fit.
type QueryHost = Partial<
  Pick<ts.ParseConfigFileHost, "readFile" | "fileExists" | "readDirectory">
> &
  Partial<
    Pick<ts.CompilerHost, "directoryExists" | "realpath" | "getDirectories">
  >;

type ReadDirectoryArgs = Parameters<ts.ParseConfigFileHost["readDirectory"]>;

export type CompilerInputRecorder = {
  /** Routes the host's file-system questions through the recorder. */
  wrap: <Host extends QueryHost>(host: Host) => Host;
  /** Records a file the caller reads outside the compiler. */
  readFile: (fileName: string) => string | undefined;
  stamp: (context: string) => CompilerInputStamp;
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

export const createCompilerInputRecorder = (): CompilerInputRecorder => {
  const contents = new Map<string, string | null>();
  const installed = new Map<string, string | null>();
  const files = new Map<string, boolean>();
  const directories = new Map<string, boolean>();
  const realpaths = new Map<string, string>();
  const subdirectories = new Map<string, string[]>();
  const listings = new Map<string, v.InferOutput<typeof readDirectorySchema>>();
  // Reads the bytes once, so the recorded hash is of the bytes the compiler
  // parsed even if the file changes while the program is built.
  const recordRead = (fileName: string) => {
    const bytes = readBytes(fileName);
    if (fileName.includes(NODE_MODULES)) {
      installed.set(
        fileName,
        bytes === undefined
          ? null
          : installedFingerprint(statSync(fileName, { throwIfNoEntry: false })),
      );
    } else {
      contents.set(fileName, contentHash(bytes));
    }
    return bytes === undefined ? undefined : decodeSource(bytes);
  };
  // Mutations go through the concrete query type, so each replacement is
  // checked against it; `wrap` hands the same object back with its own type.
  const record = (host: QueryHost): void => {
    const { fileExists, directoryExists, getDirectories, readDirectory } = host;
    const resolveRealpath = host.realpath;
    if (host.readFile !== undefined) {
      host.readFile = recordRead;
    }
    if (fileExists !== undefined) {
      host.fileExists = (fileName) => {
        const exists = fileExists.call(host, fileName);
        files.set(fileName, exists);
        return exists;
      };
    }
    if (directoryExists !== undefined) {
      host.directoryExists = (directory) => {
        const exists = directoryExists.call(host, directory);
        directories.set(directory, exists);
        return exists;
      };
    }
    if (resolveRealpath !== undefined) {
      host.realpath = (fileName) => {
        const real = resolveRealpath.call(host, fileName);
        realpaths.set(fileName, real);
        return real;
      };
    }
    if (getDirectories !== undefined) {
      host.getDirectories = (directory) => {
        const found = getDirectories.call(host, directory);
        subdirectories.set(directory, [...found]);
        return found;
      };
    }
    if (readDirectory !== undefined) {
      host.readDirectory = (...args: ReadDirectoryArgs) => {
        const found = readDirectory.call(host, ...args);
        const [directory, extensions, excludes, includes, depth] = args;
        const key: v.InferOutput<typeof readDirectorySchema>[0] = [
          directory,
          [...extensions],
          excludes === undefined ? null : [...excludes],
          [...includes],
          depth ?? null,
        ];
        listings.set(JSON.stringify(key), [key, [...found]]);
        return found;
      };
    }
  };
  const wrap = <Host extends QueryHost>(host: Host): Host => {
    record(host);
    return host;
  };
  return {
    wrap,
    readFile: recordRead,
    stamp: (context) => ({
      context,
      contents: sortedRecord(contents),
      installed: sortedRecord(installed),
      files: existence(files),
      directories: existence(directories),
      realpaths: sortedRecord(realpaths),
      subdirectories: sortedRecord(subdirectories),
      listings: [...listings]
        .toSorted(([left], [right]) => compareKeys(left, right))
        .map(([, listing]) => listing),
    }),
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

// The same answers ts.sys gives. Reads and real paths are asked concurrently
// so the file system can overlap the I/O; stat calls are cheap enough inline.
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
  for (const [directory, found] of Object.entries(stamp.subdirectories)) {
    yield () => sameStrings(ts.sys.getDirectories(directory), found);
  }
  for (const [
    [directory, extensions, excludes, includes, depth],
    found,
  ] of stamp.listings) {
    yield () =>
      sameStrings(
        ts.sys.readDirectory(
          directory,
          extensions ?? undefined,
          excludes ?? undefined,
          includes ?? undefined,
          depth ?? undefined,
        ),
        found,
      );
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

/** Hashes the relative and workspace import closure of a script. */
export const scriptSourceHash = (entry: string): string => {
  const hash = createSha256();
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    hash.update(JSON.stringify([file, sha256Hex(source)]));
    for (const { fileName } of ts.preProcessFile(source, true, true)
      .importedFiles) {
      if (fileName.startsWith(".") || fileName.startsWith("@stll/")) {
        pending.push(Bun.resolveSync(fileName, path.dirname(file)));
      }
    }
  }
  return hash.digest("hex");
};
