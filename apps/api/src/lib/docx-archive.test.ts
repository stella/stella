import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  DOCX_MAX_ENTRIES,
  DocxArchiveError,
  loadDocxArchive,
} from "@/api/lib/docx-archive";

const buildArchive = async (
  files: { path: string; content: string | Uint8Array }[],
): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content);
  }
  return await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
};

const captureRejection = async <T>(promise: Promise<T>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
};

describe("loadDocxArchive", () => {
  test("reads entries within bounds", async () => {
    const buffer = await buildArchive([
      { path: "word/document.xml", content: "<doc/>" },
      { path: "word/comments.xml", content: "<comments/>" },
    ]);
    const archive = await loadDocxArchive(buffer);
    expect(await archive.readEntryString("word/document.xml")).toBe("<doc/>");
    expect(await archive.readEntryString("word/comments.xml")).toBe(
      "<comments/>",
    );
  });

  test("returns null for missing entries", async () => {
    const buffer = await buildArchive([
      { path: "word/document.xml", content: "<doc/>" },
    ]);
    const archive = await loadDocxArchive(buffer);
    expect(await archive.readEntryString("word/missing.xml")).toBeNull();
    expect(await archive.readEntryUint8("word/missing.xml")).toBeNull();
  });

  test("rejects malformed archives with a tagged error", async () => {
    const garbage = new TextEncoder().encode("not a zip");
    const error = await captureRejection(loadDocxArchive(garbage));
    expect(error).toBeInstanceOf(DocxArchiveError);
    expect(error).toMatchObject({
      _tag: "DocxArchiveError",
      reason: "load-failed",
    });
  });

  test("rejects archives that declare too many entries", async () => {
    const files = Array.from({ length: DOCX_MAX_ENTRIES + 1 }, (_, i) => ({
      path: `entry-${i}.txt`,
      content: "x",
    }));
    const buffer = await buildArchive(files);
    const error = await captureRejection(loadDocxArchive(buffer));
    expect(error).toMatchObject({
      _tag: "DocxArchiveError",
      reason: "too-many-entries",
    });
  });

  test("rejects upfront when an entry declares oversize", async () => {
    const buffer = await buildArchive([
      { path: "huge.bin", content: "X".repeat(64) },
    ]);
    const error = await captureRejection(
      loadDocxArchive(buffer, { maxEntryBytes: 16 }),
    );
    expect(error).toMatchObject({
      _tag: "DocxArchiveError",
      reason: "entry-too-large",
    });
  });

  test("rejects upfront when the cumulative size declares oversize", async () => {
    const buffer = await buildArchive([
      { path: "a.txt", content: "X".repeat(8) },
      { path: "b.txt", content: "Y".repeat(8) },
    ]);
    const error = await captureRejection(
      loadDocxArchive(buffer, { maxTotalBytes: 12 }),
    );
    expect(error).toMatchObject({
      _tag: "DocxArchiveError",
      reason: "total-too-large",
    });
  });

  test("streaming read rejects an entry that exceeds the per-entry cap", async () => {
    const buffer = await buildArchive([
      { path: "word/document.xml", content: "<doc/>" },
      { path: "word/comments.xml", content: "X".repeat(8) },
    ]);
    const archive = await loadDocxArchive(buffer, { maxEntryBytes: 4 });
    const error = await captureRejection(
      archive.readEntryString("word/comments.xml"),
    );
    expect(error).toMatchObject({
      _tag: "DocxArchiveError",
      reason: "entry-too-large",
    });
  });

  test("serialised reads keep the cumulative budget consistent under concurrency", async () => {
    // One 6-byte entry; pre-flight passes against an 8-byte budget.
    // Reading the same entry twice in parallel costs 12 actual bytes,
    // which must exceed the cap. Without serialisation both concurrent
    // calls could observe `remaining=8` before either updates the
    // running counter and slip 4 bytes past the budget.
    const buffer = await buildArchive([
      { path: "shared.txt", content: "X".repeat(6) },
    ]);
    const archive = await loadDocxArchive(buffer, { maxTotalBytes: 8 });
    const [first, second] = await Promise.allSettled([
      archive.readEntryString("shared.txt"),
      archive.readEntryString("shared.txt"),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toMatchObject({
        _tag: "DocxArchiveError",
        reason: "total-too-large",
      });
    }
  });
});
