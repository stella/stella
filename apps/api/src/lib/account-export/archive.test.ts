import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { stat } from "node:fs/promises";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

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
  select: () => panic("Injected archive sources must not access the database"),
} satisfies AccountExportDataDb;
const userId = toSafeId<"user">("archive-account");

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
    const zip = await JSZip.loadAsync(publication.bytes);
    for (const table of EXPORTED_ACCOUNT_TABLE_NAMES) {
      expect(await zip.file(`${table}.json`)?.async("string")).toBe("[]");
    }
    const manifestText = await zip.file("manifest.json")?.async("string");
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
    const encoder = new TextEncoder();
    const chunks = [encoder.encode("first "), encoder.encode("second")];
    const injected = {
      ...deps,
      async *rows({ table }) {
        yield { table, ordinal: 1 };
        yield { table, ordinal: 2 };
      },
      async *files() {
        yield {
          path: "files/attachment",
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
    const zip = await JSZip.loadAsync(publication.bytes);
    for (const table of EXPORTED_ACCOUNT_TABLE_NAMES) {
      expect(await zip.file(`${table}.json`)?.async("string")).toBe(
        JSON.stringify([
          { table, ordinal: 1 },
          { table, ordinal: 2 },
        ]),
      );
    }
    expect(await zip.file("files/attachment")?.async("string")).toBe(
      "first second",
    );
    const manifestText = await zip.file("manifest.json")?.async("string");
    if (manifestText === undefined) {
      panic("Manifest required");
    }
    expect(JSON.parse(manifestText)).toMatchObject({
      tables: EXPORTED_ACCOUNT_TABLE_NAMES.map((table) => ({
        table,
        count: 2,
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

  test("rejects an oversized file before opening its stream", async () => {
    const { deps, published } = fixture();
    const injected = {
      ...deps,
      async *files() {
        yield {
          path: "files/oversized",
          key: testFileKey("oversized"),
          sizeBytes: ACCOUNT_EXPORT_ARCHIVE_LIMITS.archiveBytes + 1,
        };
      },
    } satisfies AccountExportArchiveDeps;
    expect(
      await rejectionOf(
        buildAccountExportArchive({
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
