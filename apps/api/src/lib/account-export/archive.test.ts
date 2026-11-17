import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import path from "node:path";

import { ZipArchive } from "@stll/docx-core/zip";
import { rejectionOf } from "@stll/property-testing/rejection";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";
import {
  ACCOUNT_EXPORT_ARCHIVE_LIMITS,
  AccountExportArchiveError,
  buildAccountExportArchive,
} from "@/api/lib/account-export/archive";
import type { AccountExportArchiveDeps } from "@/api/lib/account-export/archive";
import type { AccountExportDataDb } from "@/api/lib/account-export/pages";
import { EXPORTED_ACCOUNT_TABLE_NAMES } from "@/api/lib/account-export/registry";
import { toSafeId } from "@/api/lib/branded-types";
import { testFileKey } from "@/api/tests/helpers/file-key";

const db = {
  transaction: async () =>
    panic("Injected archive sources must not open transactions"),
  select: () => panic("Injected archive sources must not access the database"),
} satisfies AccountExportDataDb;
const userId = toSafeId<"user">("archive-account");
const organizationId = toSafeId<"organization">("archive-organization");
const encoder = new TextEncoder();

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const readJson = async (zip: ZipArchive, name: string): Promise<unknown> => {
  const text = await zip.entry(name)?.text();
  if (text === undefined) {
    panic(`Archive entry ${name} required`);
  }
  return JSON.parse(text);
};

const emptyRows = async function* () {
  yield* [];
};
const emptyFiles = async function* () {
  yield* [];
};

const fixture = () => {
  const published: {
    key: string;
    bytes: Uint8Array;
    mimeType: string;
    path: string;
  }[] = [];
  const deps = {
    rows: emptyRows,
    files: emptyFiles,
    openObject: async () => panic("Empty file source must not open objects"),
    publish: async (key, bytes, mimeType, _signal) => {
      if (
        !(bytes instanceof Blob) ||
        !("name" in bytes) ||
        typeof bytes.name !== "string"
      ) {
        panic("Archive publication must receive the spooled file");
      }
      const posture = await stat(bytes.name);
      const directoryPosture = await stat(path.dirname(bytes.name));
      expect(posture.mode % 0o1000).toBe(0o600);
      expect(directoryPosture.mode % 0o1000).toBe(0o700);
      published.push({
        key,
        bytes: new Uint8Array(await bytes.arrayBuffer()),
        mimeType,
        path: bytes.name,
      });
    },
  } satisfies AccountExportArchiveDeps;
  return { deps, published };
};

describe("account export archive", () => {
  test("writes empty table arrays and the consumed-row manifest", async () => {
    const { deps, published } = fixture();
    await buildAccountExportArchive({
      projections: ACCOUNT_EXPORT_PROJECTIONS,
      db,
      userId,
      objectKey: "archive-key",
      signal: new AbortController().signal,
      deps,
    });
    expect(published).toHaveLength(1);
    const publication = published.at(0);
    if (publication === undefined) {
      panic("Archive publication required");
    }
    expect(publication.key).toBe("archive-key");
    expect(publication.mimeType).toBe("application/zip");
    const zip = await ZipArchive.read(publication.bytes);
    for (const table of EXPORTED_ACCOUNT_TABLE_NAMES) {
      expect(await zip.entry(`${table}.json`)?.text()).toBe("[]");
    }
    const manifestText = await zip.entry("manifest.json")?.text();
    if (manifestText === undefined) {
      panic("Manifest required");
    }
    expect(JSON.parse(manifestText)).toEqual({
      schemaVersion: 1,
      generatedAt: expect.any(String),
      tables: EXPORTED_ACCOUNT_TABLE_NAMES.map((table) => ({
        table,
        count: 0,
      })),
    });
    expect(
      await rejectionOf(stat(path.dirname(publication.path))),
    ).toMatchObject({ message: expect.stringContaining("ENOENT") });
  });

  test("streams projected rows and file chunks without changing their contents", async () => {
    const { deps, published } = fixture();
    const chunks = [encoder.encode("first "), encoder.encode("second")];
    const injected = {
      ...deps,
      async *rows({ table }) {
        yield { table, ordinal: 1 };
        yield { table, ordinal: 2 };
      },
      async *files() {
        yield {
          organizationId,
          data: { archivePath: "files/attachment" },
          key: testFileKey("stored-attachment"),
          sizeBytes: 12,
        };
      },
      openObject: async (key) => {
        expect(key).toBe("stored-attachment");
        let position = 0;
        return {
          contentLength: 12,
          body: new ReadableStream<Uint8Array>({
            pull: (controller) => {
              const chunk = chunks.at(position);
              if (chunk === undefined) {
                controller.close();
                return;
              }
              position += 1;
              controller.enqueue(chunk);
            },
          }),
        };
      },
    } satisfies AccountExportArchiveDeps;
    await buildAccountExportArchive({
      projections: ACCOUNT_EXPORT_PROJECTIONS,
      db,
      userId,
      objectKey: "archive-key",
      signal: new AbortController().signal,
      deps: injected,
    });
    const publication = published.at(0);
    if (publication === undefined) {
      panic("Archive publication required");
    }
    const zip = await ZipArchive.read(publication.bytes);
    for (const table of EXPORTED_ACCOUNT_TABLE_NAMES) {
      if (table === "user_files") {
        continue;
      }
      expect(await zip.entry(`${table}.json`)?.text()).toBe(
        JSON.stringify([
          { table, ordinal: 1 },
          { table, ordinal: 2 },
        ]),
      );
    }
    expect(await readJson(zip, "user_files.json")).toEqual([
      { organizationId, data: { archivePath: "files/attachment" } },
    ]);
    expect(await zip.entry("files/attachment")?.text()).toBe("first second");
    expect(await readJson(zip, "manifest.json")).toMatchObject({
      tables: EXPORTED_ACCOUNT_TABLE_NAMES.map((table) => ({
        table,
        count: table === "user_files" ? 1 : 2,
      })),
    });
  });

  test("removes its private spool after publication fails", async () => {
    const { deps, published } = fixture();
    const failure = new AccountExportArchiveError({
      message: "Publication failed",
    });
    const injected = {
      ...deps,
      publish: async (...args) => {
        await deps.publish(...args);
        throw failure;
      },
    } satisfies AccountExportArchiveDeps;
    expect(
      await rejectionOf(
        buildAccountExportArchive({
          projections: ACCOUNT_EXPORT_PROJECTIONS,
          db,
          userId,
          objectKey: "archive-key",
          signal: new AbortController().signal,
          deps: injected,
        }),
      ),
    ).toBe(failure);
    const publication = published.at(0);
    if (publication === undefined) {
      panic("Failed publication must reach the spool");
    }
    expect(
      await rejectionOf(stat(path.dirname(publication.path))),
    ).toMatchObject({ message: expect.stringContaining("ENOENT") });
  });

  test("an aborted build never publishes an archive", async () => {
    const { deps, published } = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await rejectionOf(
        buildAccountExportArchive({
          projections: ACCOUNT_EXPORT_PROJECTIONS,
          db,
          userId,
          objectKey: "archive-key",
          signal: controller.signal,
          deps,
        }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/abort/iu) });
    expect(published).toEqual([]);
  });

  test("file metadata and bodies both come from the one inventory read", async () => {
    const { deps, published } = fixture();
    const fileRecord = (id: string) => ({
      organizationId,
      data: { archivePath: `files/${id}` },
      key: testFileKey(`stored-${id}`),
      sizeBytes: id.length,
    });
    // The account's files as stored now: the inventory read sees `kept` and
    // `deleted`; by the time bodies are read, `deleted` is gone and `added`
    // has arrived. A second inventory read would therefore disagree.
    let current = [fileRecord("kept"), fileRecord("deleted")];
    let inventoryReads = 0;
    const opened: string[] = [];
    const injected = {
      ...deps,
      async *files() {
        inventoryReads += 1;
        const snapshot = current;
        current = [fileRecord("kept"), fileRecord("added")];
        yield* snapshot;
      },
      openObject: async (key) => {
        opened.push(key);
        const present = current.find((file) => file.key === key);
        if (present === undefined) {
          return null;
        }
        const id = key.replace("stored-", "");
        return { contentLength: id.length, body: streamOf(id) };
      },
    } satisfies AccountExportArchiveDeps;
    await buildAccountExportArchive({
      projections: ACCOUNT_EXPORT_PROJECTIONS,
      db,
      userId,
      objectKey: "archive-key",
      signal: new AbortController().signal,
      deps: injected,
    });
    expect(inventoryReads).toBe(1);
    expect(opened).toEqual(["stored-kept", "stored-deleted"]);
    const publication = published.at(0);
    if (publication === undefined) {
      panic("Archive publication required");
    }
    const zip = await ZipArchive.read(publication.bytes);
    expect(await readJson(zip, "user_files.json")).toEqual([
      { organizationId, data: { archivePath: "files/kept" } },
      {
        organizationId,
        data: {
          archivePath: null,
          unavailable: { reason: "object_missing" },
        },
      },
    ]);
    // Every archivePath resolves to bytes, and every body has metadata.
    expect(zip.paths().filter((name) => name.startsWith("files/"))).toEqual([
      "files/kept",
    ]);
    expect(await zip.entry("files/kept")?.text()).toBe("kept");
    expect(await readJson(zip, "manifest.json")).toMatchObject({
      tables: expect.arrayContaining([{ table: "user_files", count: 2 }]),
    });
  });

  test("rejects an oversized file before opening its stream", async () => {
    const { deps, published } = fixture();
    const injected = {
      ...deps,
      async *files() {
        yield {
          organizationId,
          data: { archivePath: "files/oversized" },
          key: testFileKey("oversized"),
          sizeBytes: ACCOUNT_EXPORT_ARCHIVE_LIMITS.archiveBytes + 1,
        };
      },
    } satisfies AccountExportArchiveDeps;
    expect(
      await rejectionOf(
        buildAccountExportArchive({
          projections: ACCOUNT_EXPORT_PROJECTIONS,
          db,
          userId,
          objectKey: "archive-key",
          signal: new AbortController().signal,
          deps: injected,
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("file exceeds its size limit"),
    });
    expect(published).toEqual([]);
  });

  test("rejects a projected record larger than the named byte ceiling", async () => {
    const { deps, published } = fixture();
    const injected = {
      ...deps,
      async *rows() {
        yield { text: "x".repeat(ACCOUNT_EXPORT_ARCHIVE_LIMITS.recordBytes) };
      },
    } satisfies AccountExportArchiveDeps;
    expect(
      await rejectionOf(
        buildAccountExportArchive({
          projections: ACCOUNT_EXPORT_PROJECTIONS,
          db,
          userId,
          objectKey: "archive-key",
          signal: new AbortController().signal,
          deps: injected,
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("record exceeds its size limit"),
    });
    expect(published).toEqual([]);
  });
});
