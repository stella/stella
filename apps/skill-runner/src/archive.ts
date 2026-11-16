import { Result, TaggedError } from "better-result";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isSafeZipPath, ZipArchive } from "@stll/docx-core/zip";
import { sha256Hex } from "@stll/sha256/node";

export class SkillRunnerArchiveError extends TaggedError(
  "SkillRunnerArchiveError",
)<{ message: string; cause?: unknown }> {}

export type ArchiveLimits = {
  archiveBytes: number;
  uncompressedBytes: number;
  files: number;
};

/** One regular file of a folder, as the run reports it. */
export type FolderFile = { sizeBytes: number; sha256: string };

const archiveError = (message: string) => (cause: unknown) =>
  new SkillRunnerArchiveError({ message, cause });

/**
 * Write a zip archive's files under `root`. Every entry must be a safe
 * relative path; directory entries only make folders. A zip holds no links
 * or modes, so nothing it holds can point outside `root`.
 */
export const extractArchive = async (
  bytes: Uint8Array,
  root: string,
  limits: ArchiveLimits,
): Promise<Result<void, SkillRunnerArchiveError>> => {
  if (bytes.byteLength > limits.archiveBytes) {
    return Result.err(
      new SkillRunnerArchiveError({ message: "Archive is too large" }),
    );
  }
  const archive = await Result.tryPromise({
    try: async () =>
      await ZipArchive.read(bytes, {
        limits: {
          maxEntries: limits.files,
          maxEntryBytes: limits.uncompressedBytes,
          maxTotalBytes: limits.uncompressedBytes,
        },
      }),
    catch: archiveError("Archive is not valid"),
  });
  if (archive.isErr()) {
    return Result.err(archive.error);
  }
  for (const entry of archive.value.entries()) {
    const directory = entry.path.endsWith("/");
    const name = directory ? entry.path.slice(0, -1) : entry.path;
    if (!isSafeZipPath(name)) {
      return Result.err(
        new SkillRunnerArchiveError({
          message: `Archive entry leaves its folder: ${entry.path}`,
        }),
      );
    }
    const target = path.join(root, name);
    const written = await Result.tryPromise({
      try: async () => {
        if (directory) {
          await mkdir(target, { recursive: true });
          return;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await entry.bytes(), { flag: "wx" });
      },
      catch: archiveError(`Archive entry could not be written: ${entry.path}`),
    });
    if (written.isErr()) {
      return Result.err(written.error);
    }
  }
  return Result.ok(undefined);
};

/**
 * Every regular file under `root` with its size and SHA-256, keyed by its
 * forward-slash path, in path order. Links are neither followed nor listed:
 * a command can make one, but it never leaves the sandbox.
 */
export const listFolder = async (
  root: string,
  limits: Pick<ArchiveLimits, "files" | "uncompressedBytes">,
): Promise<Result<Map<string, FolderFile>, SkillRunnerArchiveError>> => {
  const files = new Map<string, FolderFile>();
  const pending: { dir: string; prefix: string }[] = [
    { dir: root, prefix: "" },
  ];
  let totalBytes = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { dir, prefix } = next;
    const entries = await Result.tryPromise({
      try: async () => await readdir(dir, { withFileTypes: true }),
      catch: archiveError("Workspace folder could not be read"),
    });
    if (entries.isErr()) {
      return Result.err(entries.error);
    }
    for (const entry of entries.value) {
      const full = path.join(dir, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const remainingBytes = limits.uncompressedBytes - totalBytes;
      const read = await Result.tryPromise({
        try: async () => {
          const stat = await lstat(full);
          if (stat.isDirectory()) {
            return { type: "folder" } as const;
          }
          if (!stat.isFile()) {
            return { type: "other" } as const;
          }
          // Checked before reading, so a file past the limit is never
          // buffered. The runner lists a workspace only while nothing else
          // runs in it: before the command and after the sweep.
          if (stat.size > remainingBytes) {
            return { type: "too-large" } as const;
          }
          return {
            type: "file",
            content: await readFile(full),
          } as const;
        },
        catch: archiveError(`Workspace file could not be read: ${relative}`),
      });
      if (read.isErr()) {
        return Result.err(read.error);
      }
      if (read.value.type === "folder") {
        pending.push({ dir: full, prefix: relative });
        continue;
      }
      if (read.value.type === "other") {
        continue;
      }
      if (read.value.type === "too-large") {
        return Result.err(
          new SkillRunnerArchiveError({
            message: "Workspace holds more than a run may keep",
          }),
        );
      }
      totalBytes += read.value.content.byteLength;
      if (
        files.size + 1 > limits.files ||
        totalBytes > limits.uncompressedBytes
      ) {
        return Result.err(
          new SkillRunnerArchiveError({
            message: "Workspace holds more than a run may keep",
          }),
        );
      }
      files.set(relative, {
        sizeBytes: read.value.content.byteLength,
        sha256: sha256Hex(read.value.content),
      });
    }
  }
  return Result.ok(
    new Map([...files].toSorted(([a], [b]) => (a < b ? -1 : 1))),
  );
};

/** The listed files of `root` as one zip archive. */
export const packFolder = async (
  root: string,
  files: ReadonlyMap<string, FolderFile>,
): Promise<Result<Uint8Array, SkillRunnerArchiveError>> =>
  await Result.tryPromise({
    try: async () => {
      const archive = new ZipArchive();
      for (const relative of files.keys()) {
        archive.set(relative, await readFile(path.join(root, relative)));
      }
      return await archive.generate();
    },
    catch: archiveError("Workspace could not be packed"),
  });
