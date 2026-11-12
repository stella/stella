import { TaggedError } from "better-result";
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

/**
 * Write a zip archive's files under `root`. Every entry must be a safe
 * relative path; directory entries only make folders. A zip holds no links
 * or modes, so nothing it holds can point outside `root`.
 */
export const extractArchive = async (
  bytes: Uint8Array,
  root: string,
  limits: ArchiveLimits,
): Promise<void> => {
  if (bytes.byteLength > limits.archiveBytes) {
    throw new SkillRunnerArchiveError({ message: "Archive is too large" });
  }
  const archive = await ZipArchive.read(bytes, {
    limits: {
      maxEntries: limits.files,
      maxEntryBytes: limits.uncompressedBytes,
      maxTotalBytes: limits.uncompressedBytes,
    },
  }).catch((error: unknown) => {
    throw new SkillRunnerArchiveError({
      message: "Archive is not valid",
      cause: error,
    });
  });
  await mkdir(root, { recursive: true });
  for (const entry of archive.entries()) {
    const name = entry.path.endsWith("/")
      ? entry.path.slice(0, -1)
      : entry.path;
    if (!isSafeZipPath(name)) {
      throw new SkillRunnerArchiveError({
        message: `Archive entry leaves its folder: ${entry.path}`,
      });
    }
    const target = path.join(root, name);
    if (entry.path.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.bytes(), { flag: "wx" });
  }
};

/**
 * Every regular file under `root` with its size and SHA-256, keyed by its
 * forward-slash path. Links are neither followed nor listed: a command can
 * make one, but it never leaves the sandbox.
 */
export const listFolder = async (
  root: string,
  limits: Pick<ArchiveLimits, "files" | "uncompressedBytes">,
): Promise<Map<string, FolderFile>> => {
  const files = new Map<string, FolderFile>();
  let totalBytes = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(dir, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const stat = await lstat(full);
      if (stat.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      totalBytes += stat.size;
      if (
        files.size + 1 > limits.files ||
        totalBytes > limits.uncompressedBytes
      ) {
        throw new SkillRunnerArchiveError({
          message: "Workspace holds more than a run may keep",
        });
      }
      const content = await readFile(full);
      files.set(relative, {
        sizeBytes: stat.size,
        sha256: sha256Hex(content),
      });
    }
  };
  await walk(root, "");
  return files;
};

/** The listed files of `root` as one zip archive. */
export const packFolder = async (
  root: string,
  files: ReadonlyMap<string, FolderFile>,
): Promise<Uint8Array> => {
  const archive = new ZipArchive();
  for (const relative of files.keys()) {
    archive.set(relative, await readFile(path.join(root, relative)));
  }
  return await archive.generate();
};
