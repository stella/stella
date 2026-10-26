// Every file tracked at HEAD stays within TRACKED_FILE_SIZE_LIMIT_BYTES, so
// generated output such as a built bundle cannot be committed: it bloats every
// clone and every rebase that conflicts on it.
//
// Sizes are blob sizes from `git ls-tree`, so untracked and ignored files never
// count and nothing walks the working tree. Files that must stay tracked above
// the limit sit in scripts/tracked-file-size-baseline.json, one reason and one
// byte ceiling each. A file that grows past its ceiling fails, and an entry
// whose file is gone or back within the limit fails as stale, so the baseline
// can only shrink unless a reviewed change adds to it.
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { BASELINE_PATHS } from "./baseline-paths";
import { ledgerGitEnv } from "./ledger-membership";

export const TRACKED_FILE_SIZE_LIMIT_BYTES = 1024 * 1024;

const BASELINE_REL = BASELINE_PATHS.trackedFileSizes;

const BaselineSchema = v.array(
  v.strictObject({
    path: v.pipe(v.string(), v.minLength(1, "path is required")),
    maxBytes: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(
        TRACKED_FILE_SIZE_LIMIT_BYTES + 1,
        "maxBytes must exceed the limit; a file within it needs no entry",
      ),
    ),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1, "reason is required")),
  }),
);

export type SizeBaselineEntry = v.InferOutput<typeof BaselineSchema>[number];

/** The baseline entries; duplicate paths and blank reasons fail. */
export const parseSizeBaseline = (
  text: string,
  label: string,
): SizeBaselineEntry[] => {
  const parsed = v.safeParse(BaselineSchema, JSON.parse(text));
  if (!parsed.success) {
    return panic(
      `${label}: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const paths = parsed.output.map((entry) => entry.path);
  const duplicate = paths.find((file, index) => paths.indexOf(file) !== index);
  if (duplicate !== undefined) {
    return panic(`${label}: duplicate entry ${duplicate}`);
  }
  return parsed.output;
};

export type TrackedBlob = { path: string; bytes: number };

// `git ls-tree -l -z` record: "<mode> <type> <oid> <padded size>\t<path>".
const LS_TREE_RECORD =
  /^\d+ (?<type>\w+) [0-9a-f]+ +(?<size>\d+|-)\t(?<path>.+)$/su;

/** Every blob in HEAD with its size; submodule commits carry no size. */
export const trackedBlobs = (root: string): TrackedBlob[] => {
  const listed = Bun.spawnSync(["git", "ls-tree", "-r", "-l", "-z", "HEAD"], {
    cwd: root,
    env: ledgerGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    return panic(`git ls-tree HEAD failed: ${listed.stderr.toString()}`);
  }
  return listed.stdout
    .toString()
    .split("\0")
    .filter((record) => record !== "")
    .flatMap((record) => {
      const groups = LS_TREE_RECORD.exec(record)?.groups;
      if (groups === undefined) {
        return panic(`unexpected git ls-tree record: ${record}`);
      }
      const { type, size, path: file } = groups;
      if (type !== "blob" || size === undefined || file === undefined) {
        return [];
      }
      return [{ path: file, bytes: Number(size) }];
    });
};

const describeSize = (bytes: number) =>
  `${bytes} bytes (${(bytes / TRACKED_FILE_SIZE_LIMIT_BYTES).toFixed(2)} MiB)`;

export type SizeReport = { errors: string[]; baselined: number };

/** Oversized blobs the baseline does not cover, and baseline entries now stale. */
export const evaluateSizes = (
  blobs: readonly TrackedBlob[],
  baseline: readonly SizeBaselineEntry[],
): SizeReport => {
  const entries = new Map(baseline.map((entry) => [entry.path, entry]));
  const sizes = new Map(blobs.map((blob) => [blob.path, blob.bytes]));
  const oversized = blobs.filter(
    (blob) => blob.bytes > TRACKED_FILE_SIZE_LIMIT_BYTES,
  );
  const errors: string[] = [];
  for (const { path: file, bytes } of oversized) {
    const entry = entries.get(file);
    if (entry === undefined) {
      errors.push(
        `${file}: ${describeSize(bytes)} exceeds the ${describeSize(TRACKED_FILE_SIZE_LIMIT_BYTES)} limit for tracked files. Generated output belongs in .gitignore and is built where it is used; a file that must be tracked needs a { path, maxBytes, reason } entry in ${BASELINE_REL}.`,
      );
      continue;
    }
    if (bytes > entry.maxBytes) {
      errors.push(
        `${file}: ${describeSize(bytes)} exceeds its baselined ceiling of ${describeSize(entry.maxBytes)} in ${BASELINE_REL}; shrink the file below the ceiling.`,
      );
    }
  }
  for (const { path: file } of baseline) {
    const bytes = sizes.get(file);
    if (bytes === undefined) {
      errors.push(
        `${BASELINE_REL}: stale entry ${file}; the file is not tracked, so delete the entry`,
      );
      continue;
    }
    if (bytes <= TRACKED_FILE_SIZE_LIMIT_BYTES) {
      errors.push(
        `${BASELINE_REL}: stale entry ${file}; the file is ${describeSize(bytes)}, within the limit, so delete the entry`,
      );
    }
  }
  return {
    errors,
    baselined: oversized.filter((blob) => entries.has(blob.path)).length,
  };
};

if (import.meta.main) {
  const root = process.cwd();
  const baseline = parseSizeBaseline(
    readFileSync(path.join(root, BASELINE_REL), "utf-8"),
    BASELINE_REL,
  );
  const report = evaluateSizes(trackedBlobs(root), baseline);
  for (const error of report.errors) {
    process.stderr.write(`${error}\n`);
  }
  if (report.errors.length > 0) {
    process.exit(1);
  }
  process.stdout.write(
    `Tracked file sizes: OK. ${report.baselined} baselined ${report.baselined === 1 ? "file" : "files"} above ${describeSize(TRACKED_FILE_SIZE_LIMIT_BYTES)}.\n`,
  );
}
