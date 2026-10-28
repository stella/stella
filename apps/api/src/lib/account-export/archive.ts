import { panic, TaggedError } from "better-result";
import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { zipStream } from "@stll/docx-core/zip/stream";
import { Temporal } from "@stll/time";

import {
  exportAccountFiles,
  exportAccountRows,
} from "@/api/lib/account-export/pages";
import type {
  AccountExportDataDb,
  AccountExportFile,
} from "@/api/lib/account-export/pages";
import type { AccountExportProjections } from "@/api/lib/account-export/projections";
import { EXPORTED_ACCOUNT_TABLE_NAMES } from "@/api/lib/account-export/registry";
import type { SafeId } from "@/api/lib/branded-types";
import {
  openS3ObjectStreamIfPresent,
  putTemporaryS3ObjectWithSignal,
} from "@/api/lib/s3";

export const ACCOUNT_EXPORT_ARCHIVE_LIMITS = {
  archiveBytes: 1024 * 1024 * 1024,
  recordBytes: 10 * 1024 * 1024,
  buildMs: 10 * 60 * 1000,
  files: 10_000,
} as const;

export class AccountExportArchiveError extends TaggedError(
  "AccountExportArchiveError",
)<{
  message: string;
}> {}

type BuildAccountExportArchiveOptions = {
  projections: AccountExportProjections;
  db: AccountExportDataDb;
  userId: SafeId<"user">;
  objectKey: string;
  signal: AbortSignal;
  deps?: AccountExportArchiveDeps;
};

export type AccountExportArchiveDeps = {
  rows: typeof exportAccountRows;
  files: typeof exportAccountFiles;
  openObject: typeof openS3ObjectStreamIfPresent;
  publish: typeof putTemporaryS3ObjectWithSignal;
};

const archiveDeps = {
  rows: exportAccountRows,
  files: exportAccountFiles,
  openObject: openS3ObjectStreamIfPresent,
  publish: putTemporaryS3ObjectWithSignal,
} satisfies AccountExportArchiveDeps;

/**
 * Why an inventoried file carries no bytes in the archive. `object_missing`:
 * the object was gone when its body was read, typically because the file was
 * deleted after the inventory was taken.
 */
type AccountExportFileUnavailableReason = "object_missing";

// A projection may yield a value JSON cannot represent, such as undefined.
const serializeRecord = (row: unknown): string | undefined =>
  JSON.stringify(row);

const serializeBoundedRecord = (row: unknown): string => {
  const serialized = serializeRecord(row);
  if (serialized === undefined) {
    panic("Account export projection must produce JSON");
  }
  if (
    Buffer.byteLength(serialized, "utf-8") >
    ACCOUNT_EXPORT_ARCHIVE_LIMITS.recordBytes
  ) {
    throw new AccountExportArchiveError({
      message: "Account export record exceeds its size limit",
    });
  }
  return serialized;
};

/**
 * The user_files.json record for one inventoried file. An unavailable file
 * keeps its metadata, but its archivePath is null and the record names why:
 * an archivePath always resolves to an entry in the same archive.
 */
const userFileRecord = (
  file: AccountExportFile,
  unavailable: AccountExportFileUnavailableReason | undefined,
) => ({
  organizationId: file.organizationId,
  data:
    unavailable === undefined
      ? file.data
      : {
          ...file.data,
          archivePath: null,
          unavailable: { reason: unavailable },
        },
});

/**
 * Stream table arrays and object bodies into one bounded, private spool.
 *
 * Files are read once, as an inventory: user_files.json and the file entries
 * both come from it, so the archive never holds bytes without metadata or
 * metadata whose archivePath has no bytes. Bodies are written before
 * user_files.json, which then records any inventoried object that was gone
 * by the time its body was read.
 */
export const buildAccountExportArchive = async ({
  projections,
  db,
  userId,
  objectKey,
  signal,
  deps = archiveDeps,
}: BuildAccountExportArchiveOptions): Promise<void> => {
  const generatedAt = Temporal.Now.instant().toString();
  const encoder = new TextEncoder();
  const tables: { table: string; count: number }[] = [];

  const readFileInventory = async () => {
    const inventory: AccountExportFile[] = [];
    for await (const file of deps.files({ projections, db, userId, signal })) {
      signal.throwIfAborted();
      // The archive writer retains one central-directory record per entry.
      if (inventory.length >= ACCOUNT_EXPORT_ARCHIVE_LIMITS.files) {
        throw new AccountExportArchiveError({
          message: "Account export exceeds its file-count limit",
        });
      }
      if (file.sizeBytes > ACCOUNT_EXPORT_ARCHIVE_LIMITS.archiveBytes) {
        throw new AccountExportArchiveError({
          message: "Account export file exceeds its size limit",
        });
      }
      inventory.push(file);
    }
    return inventory;
  };

  const entries = async function* () {
    // One inventory read: user_files.json and the file entries both come from it.
    const inventory = await readFileInventory();
    const userFilesSummary = { table: "user_files", count: 0 };
    for (const table of EXPORTED_ACCOUNT_TABLE_NAMES) {
      if (table === "user_files") {
        tables.push(userFilesSummary);
        continue;
      }
      const summary = { table, count: 0 };
      tables.push(summary);
      const tableJson = async function* () {
        yield encoder.encode("[");
        for await (const row of deps.rows({
          projections,
          db,
          userId,
          table,
          signal,
        })) {
          signal.throwIfAborted();
          const bytes = encoder.encode(serializeBoundedRecord(row));
          if (summary.count > 0) {
            yield encoder.encode(",");
          }
          yield bytes;
          summary.count += 1;
        }
        yield encoder.encode("]");
      };
      yield { path: `${table}.json`, data: tableJson() };
    }
    const unavailable = new Map<
      AccountExportFile,
      AccountExportFileUnavailableReason
    >();
    for (const file of inventory) {
      signal.throwIfAborted();
      const source = await deps.openObject(file.key, signal);
      if (source === null) {
        unavailable.set(file, "object_missing");
        continue;
      }
      if (
        source.contentLength !== undefined &&
        source.contentLength !== file.sizeBytes
      ) {
        await source.body.cancel();
        throw new AccountExportArchiveError({
          message: "Account export file size differs from its stored metadata",
        });
      }
      yield { path: file.data.archivePath, data: source.body };
    }
    // The inventory is already held in memory, so its records are too.
    const userFileRecords = inventory.map((file) =>
      serializeBoundedRecord(userFileRecord(file, unavailable.get(file))),
    );
    userFilesSummary.count = userFileRecords.length;
    yield {
      path: "user_files.json",
      data: encoder.encode(`[${userFileRecords.join(",")}]`),
    };
    // The archive writer consumes each entry before requesting the next: these
    // counts describe rows written, rather than a separate drifting census.
    yield {
      path: "manifest.json",
      data: encoder.encode(
        JSON.stringify({ schemaVersion: 1, generatedAt, tables }),
      ),
    };
  };

  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-account-export-"),
  );
  try {
    await chmod(directory, 0o700);
    const archivePath = path.join(directory, "archive.zip");
    let archiveBytes = 0;
    const ceiling = new Transform({
      transform: (chunk: unknown, _encoding, callback) => {
        if (!(chunk instanceof Uint8Array)) {
          callback(
            new AccountExportArchiveError({
              message: "Account export stream produced a non-byte chunk",
            }),
          );
          return;
        }
        archiveBytes += chunk.byteLength;
        if (archiveBytes > ACCOUNT_EXPORT_ARCHIVE_LIMITS.archiveBytes) {
          callback(
            new AccountExportArchiveError({
              message: "Account export archive exceeds its size limit",
            }),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(zipStream(entries())),
      ceiling,
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal.throwIfAborted();
    await deps.publish(
      objectKey,
      Bun.file(archivePath),
      "application/zip",
      signal,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
