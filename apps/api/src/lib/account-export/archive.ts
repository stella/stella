import { panic, TaggedError } from "better-result";
import { makeZip } from "client-zip";
import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Temporal } from "@stll/time";

import {
  exportAccountFiles,
  exportAccountRows,
} from "@/api/lib/account-export/pages";
import type { AccountExportDataDb } from "@/api/lib/account-export/pages";
import type { AccountExportProjections } from "@/api/lib/account-export/projections";
import { EXPORTED_ACCOUNT_TABLE_NAMES } from "@/api/lib/account-export/registry";
import type { SafeId } from "@/api/lib/branded-types";
import {
  openS3ObjectStreamWithSignal,
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
  openObject: typeof openS3ObjectStreamWithSignal;
  publish: typeof putTemporaryS3ObjectWithSignal;
};

const archiveDeps = {
  rows: exportAccountRows,
  files: exportAccountFiles,
  openObject: openS3ObjectStreamWithSignal,
  publish: putTemporaryS3ObjectWithSignal,
} satisfies AccountExportArchiveDeps;

// A projection may yield a value JSON cannot represent, such as undefined.
const serializeRecord = (row: unknown): string | undefined =>
  JSON.stringify(row);

/** Stream table arrays and object bodies into one bounded, private spool. */
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

  const entries = async function* () {
    for (const table of EXPORTED_ACCOUNT_TABLE_NAMES) {
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
          const bytes = encoder.encode(serialized);
          if (summary.count > 0) {
            yield encoder.encode(",");
          }
          yield bytes;
          summary.count += 1;
        }
        yield encoder.encode("]");
      };
      yield { name: `${table}.json`, input: tableJson() };
    }
    let fileCount = 0;
    for await (const file of deps.files({ projections, db, userId, signal })) {
      signal.throwIfAborted();
      fileCount += 1;
      // client-zip retains one central-directory record per entry.
      if (fileCount > ACCOUNT_EXPORT_ARCHIVE_LIMITS.files) {
        throw new AccountExportArchiveError({
          message: "Account export exceeds its file-count limit",
        });
      }
      if (file.sizeBytes > ACCOUNT_EXPORT_ARCHIVE_LIMITS.archiveBytes) {
        throw new AccountExportArchiveError({
          message: "Account export file exceeds its size limit",
        });
      }
      const source = await deps.openObject(file.key, signal);
      if (
        source.contentLength !== undefined &&
        source.contentLength !== file.sizeBytes
      ) {
        await source.body.cancel();
        throw new AccountExportArchiveError({
          message: "Account export file size differs from its stored metadata",
        });
      }
      yield { name: file.path, input: source.body, size: file.sizeBytes };
    }
    // client-zip consumes each entry before requesting the next: these
    // counts describe rows written, rather than a separate drifting census.
    yield {
      name: "manifest.json",
      input: encoder.encode(
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
        if (!Buffer.isBuffer(chunk)) {
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
      Readable.from(makeZip(entries())),
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
