import { panic } from "better-result";
import { Buffer } from "node:buffer";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * The file an offline indexer reads for one shard. Blocks are written to a
 * staging file as they are built, so a shard never sits in memory; the file
 * the indexer may open appears, by rename, only after its revisions started
 * and holds exactly their blocks, in build order. The staging name starts
 * with a dot, which the engine's job contract never claims.
 */
export type CorpusProjectionShardStaging = {
  readonly stagingPath: string;
  readonly finalPath: string;
  /** Append one block; returns where it lies in the staging file. */
  append: (block: string) => Promise<CorpusProjectionShardRange>;
  /** Bytes written so far. */
  bytes: () => number;
  /**
   * Make the file of exactly `ranges` durable at `finalPath` and remove the
   * staging file. `ranges` are a subsequence of what `append` returned.
   */
  finish: (
    ranges: readonly CorpusProjectionShardRange[],
  ) => Promise<{ path: string; bytes: number }>;
  /** Remove whatever this shard wrote. */
  discard: () => Promise<void>;
};

export type CorpusProjectionShardRange = { offset: number; length: number };

const writeAll = async (
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> => {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (bytesWritten <= 0) {
      return panic("Offline projection shard write made no progress");
    }
    written += bytesWritten;
  }
};

const readAll = async (
  handle: FileHandle,
  { offset, length }: CorpusProjectionShardRange,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(
      buffer,
      read,
      length - read,
      offset + read,
    );
    if (bytesRead <= 0) {
      return panic("Offline projection staging file is shorter than written");
    }
    read += bytesRead;
  }
  return buffer;
};

const sameRanges = (
  left: readonly CorpusProjectionShardRange[],
  right: readonly CorpusProjectionShardRange[],
) =>
  left.length === right.length &&
  left.every(
    (range, index) =>
      range.offset === right.at(index)?.offset &&
      range.length === right.at(index)?.length,
  );

export const openCorpusProjectionShardStaging = async (
  directory: string,
  name: string,
): Promise<CorpusProjectionShardStaging> => {
  if (!path.isAbsolute(directory)) {
    return panic("Offline projection shard directory must be absolute");
  }
  const stagingPath = path.join(directory, `.${name}.ndjson.staging`);
  const finalPath = path.join(directory, `${name}.ndjson`);
  // `wx+`: a shard name is fresh, so an existing file is a reused name; the
  // handle also reads, to copy only the started blocks.
  const handle = await open(stagingPath, "wx+");
  const appended: CorpusProjectionShardRange[] = [];
  let size = 0;
  let open_ = true;
  const close = async () => {
    if (open_) {
      open_ = false;
      await handle.close();
    }
  };
  return {
    stagingPath,
    finalPath,
    append: async (block) => {
      const bytes = Buffer.from(block, "utf-8");
      const range = { offset: size, length: bytes.length };
      await writeAll(handle, bytes, size);
      size += bytes.length;
      appended.push(range);
      return range;
    },
    bytes: () => size,
    finish: async (ranges) => {
      if (ranges.length === 0) {
        return panic("Offline projection shard has no started revision");
      }
      if (sameRanges(ranges, appended)) {
        await handle.sync();
        await close();
        await rename(stagingPath, finalPath);
        return { path: finalPath, bytes: size };
      }
      const target = await open(finalPath, "wx");
      let position = 0;
      for (const range of ranges) {
        const block = await readAll(handle, range);
        await writeAll(target, block, position);
        position += block.length;
      }
      await target.sync();
      await target.close();
      await close();
      await rm(stagingPath, { force: true });
      return { path: finalPath, bytes: position };
    },
    discard: async () => {
      await close();
      await rm(stagingPath, { force: true });
      await rm(finalPath, { force: true });
    },
  };
};
