// A host-wide store of generated outputs, shared by every checkout on the
// machine (and restorable into CI): each entry is one printout plus the
// portable stamp of the compiler inputs it came from. A checkout whose own
// cache misses restores the newest entry whose stamp its files still satisfy,
// in seconds, instead of building the program again.
import { Result } from "better-result";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import {
  type CompilerInputStamp,
  compilerInputStampSchema,
  isCompilerInputStampCurrent,
  localizeStamp,
} from "./compiler-input-stamp";

const STAMP_FILE = "stamp.json";
const OUTPUT_FILE = "output";
// Entries kept per store; the oldest by last use go first. A restore tries
// every kept entry, newest first; each miss stops at its first changed input.
export const KEEP_ENTRIES = 16;
// A publication's temporary directory older than this was abandoned by a
// process that died before its cleanup ran.
export const ABANDONED_TEMPORARY_MS = 60 * 60 * 1000;
const TEMPORARY_PATTERN = /^\..+\.\d+\.tmp$/u;

const entrySchema = v.strictObject({
  outputHash: v.string(),
  inputs: compilerInputStampSchema,
});

/** `STELLA_GENERATED_STORE` overrides the location (CI points it at a cache). */
export const generatedStoreDir = (name: string) =>
  path.join(
    process.env["STELLA_GENERATED_STORE"] ??
      path.join(homedir(), ".cache/stella/generated"),
    name,
  );

const readOptional = (file: string) => {
  const read = Result.try(() => readFileSync(file));
  return read.isOk() ? read.value : undefined;
};

const entriesNewestFirst = (storeDir: string) => {
  const listed = Result.try(() => readdirSync(storeDir));
  if (listed.isErr()) {
    return [];
  }
  return listed.value
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => {
      const stats = Result.try(() =>
        statSync(path.join(storeDir, name), { throwIfNoEntry: false }),
      );
      // An entry that cannot be inspected sorts oldest: a restore skips it
      // as unreadable and pruning removes it first.
      if (stats.isErr()) {
        return [{ name, used: 0 }];
      }
      return stats.value?.isDirectory() === true
        ? [{ name, used: stats.value.mtimeMs }]
        : [];
    })
    .toSorted((left, right) => right.used - left.used);
};

/**
 * Adds an output under its content address; an existing entry is only marked
 * as used. Writes into a temporary directory and renames it into place, so a
 * reader never sees half an entry. Keeps the KEEP_ENTRIES most recently used.
 */
export const publishGeneratedOutput = ({
  storeDir,
  stamp,
  output,
}: {
  storeDir: string;
  stamp: CompilerInputStamp;
  output: string;
}) => {
  const entry = { outputHash: sha256Hex(output), inputs: stamp };
  const serialized = JSON.stringify(entry);
  const name = sha256Hex(serialized);
  const destination = path.join(storeDir, name);
  mkdirSync(storeDir, { recursive: true });
  if (statSync(destination, { throwIfNoEntry: false }) !== undefined) {
    const now = new Date();
    utimesSync(destination, now, now);
  } else {
    const temporary = path.join(storeDir, `.${name}.${process.pid}.tmp`);
    try {
      mkdirSync(temporary);
      writeFileSync(path.join(temporary, OUTPUT_FILE), output);
      writeFileSync(path.join(temporary, STAMP_FILE), serialized);
      // Another process may publish the same entry first; theirs is equal.
      const published = Result.try(() => renameSync(temporary, destination));
      if (
        published.isErr() &&
        statSync(destination, { throwIfNoEntry: false }) === undefined
      ) {
        throw published.error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  for (const stale of entriesNewestFirst(storeDir).slice(KEEP_ENTRIES)) {
    rmSync(path.join(storeDir, stale.name), { recursive: true, force: true });
  }
  removeAbandonedTemporaries(storeDir);
};

const removeAbandonedTemporaries = (storeDir: string) => {
  const cutoff = Date.now() - ABANDONED_TEMPORARY_MS;
  for (const name of readdirSync(storeDir)) {
    const temporary = path.join(storeDir, name);
    if (
      TEMPORARY_PATTERN.test(name) &&
      (statSync(temporary, { throwIfNoEntry: false })?.mtimeMs ?? cutoff) <
        cutoff
    ) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
};

/**
 * The newest stored output whose inputs this checkout (at `root`) still has
 * unchanged, or undefined. Unreadable or torn entries are skipped.
 */
export const restoreGeneratedOutput = async ({
  storeDir,
  root,
  context,
}: {
  storeDir: string;
  root: string;
  context: string;
}): Promise<
  { output: Buffer; stamp: CompilerInputStamp; outputHash: string } | undefined
> => {
  for (const { name } of entriesNewestFirst(storeDir)) {
    const directory = path.join(storeDir, name);
    const stampBytes = readOptional(path.join(directory, STAMP_FILE));
    const output = readOptional(path.join(directory, OUTPUT_FILE));
    if (stampBytes === undefined || output === undefined) {
      continue;
    }
    const parsed = Result.try(() =>
      v.parse(entrySchema, JSON.parse(stampBytes.toString("utf-8"))),
    );
    if (
      parsed.isErr() ||
      parsed.value.inputs.context !== context ||
      parsed.value.outputHash !== sha256Hex(output)
    ) {
      continue;
    }
    const stamp = localizeStamp(parsed.value.inputs, root);
    if (
      stamp !== undefined &&
      (await isCompilerInputStampCurrent(stamp, context))
    ) {
      const now = new Date();
      // Another process may evict the entry meanwhile; this read still holds.
      const touched = Result.try(() => utimesSync(directory, now, now));
      if (
        touched.isErr() &&
        statSync(directory, { throwIfNoEntry: false }) !== undefined
      ) {
        throw touched.error;
      }
      return { output, stamp, outputHash: parsed.value.outputHash };
    }
  }
  return undefined;
};
