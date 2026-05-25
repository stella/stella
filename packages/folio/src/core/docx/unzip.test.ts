import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  DocxSecurityError,
  extractFile,
  getFileList,
  unzipDocx,
} from "./unzip";

describe("unzipDocx security limits", () => {
  test("rejects input larger than the configured limit", async () => {
    const error = await getRejectedError(
      unzipDocx(new ArrayBuffer(2), { maxInputBytes: 1 }),
    );

    expect(error).toBeInstanceOf(DocxSecurityError);
  });

  test("rejects archives with too many file entries", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const error = await getRejectedError(unzipDocx(buffer, { maxFiles: 1 }));

    expect(error).toBeInstanceOf(DocxSecurityError);
  });

  test("accepts large document XML entries within the default limit", async () => {
    const zip = new JSZip();
    const largeBody = "x".repeat(26 * 1024 * 1024);
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", `<w:document>${largeBody}</w:document>`);

    const content = await unzipDocx(
      await zip.generateAsync({
        compression: "DEFLATE",
        type: "arraybuffer",
      }),
    );

    expect(content.documentXml?.length).toBe(
      "<w:document></w:document>".length + largeBody.length,
    );
  });

  test("accepts large header XML entries within the default limit", async () => {
    const zip = new JSZip();
    const largeHeader = "x".repeat(65 * 1024 * 1024);
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    zip.file("word/header3.xml", `<w:hdr>${largeHeader}</w:hdr>`);

    const content = await unzipDocx(
      await zip.generateAsync({
        compression: "DEFLATE",
        type: "arraybuffer",
      }),
    );

    expect(content.headers.get("header3.xml")?.length).toBe(
      "<w:hdr></w:hdr>".length + largeHeader.length,
    );
  });

  test("accepts media-heavy packages within the default file-count limit", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    for (let index = 0; index < 3800; index += 1) {
      zip.file(
        `word/media/image${index}.png`,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
      );
    }

    const content = await unzipDocx(
      await zip.generateAsync({ type: "arraybuffer" }),
    );

    expect(content.media.size).toBe(3800);
  });

  test("repairs archives missing the end-of-central-directory tail", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const truncated = truncateAfterEndOfCentralDirectoryCounts(buffer);
    const content = await unzipDocx(truncated);

    expect(content.documentXml).toBe("<w:document />");
    expect(content.originalBuffer.byteLength).toBe(buffer.byteLength);
    expect(getFileList(content)).toEqual([
      "[Content_Types].xml",
      "word/document.xml",
    ]);
  });

  test("rejects unsafe archive paths", async () => {
    const zip = new JSZip();
    zip.file("/word/document.xml", "<w:document />");

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const error = await getRejectedError(unzipDocx(buffer));

    expect(error).toBeInstanceOf(DocxSecurityError);
  });

  test("skips media entries with mismatched content signatures", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    zip.file("word/media/image1.png", new Uint8Array([0x00, 0x00, 0x00, 0x00]));

    const content = await unzipDocx(
      await zip.generateAsync({ type: "arraybuffer" }),
    );

    expect(content.media.size).toBe(0);
  });

  test("loads valid media without eager data URL conversion", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    zip.file(
      "word/media/image1.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );

    const content = await unzipDocx(
      await zip.generateAsync({ type: "arraybuffer" }),
    );

    expect(content.media.has("word/media/image1.png")).toBe(true);
  });

  test("does not expose active or embedded payload entries for preservation", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    zip.file("word/vbaProject.bin", new Uint8Array([0x00]));
    zip.file("word/embeddings/oleObject1.bin", new Uint8Array([0x00]));

    const content = await unzipDocx(
      await zip.generateAsync({ type: "arraybuffer" }),
    );

    expect(content.media.size).toBe(0);
    expect(getFileList(content)).toEqual([
      "[Content_Types].xml",
      "word/document.xml",
    ]);
    expect(await extractFile(content, "word/vbaProject.bin")).toBeNull();
  });

  test("preserves known vector image entries without loading them by default", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    zip.file("word/media/image1.emf", new Uint8Array([0x01, 0x02]));

    const content = await unzipDocx(
      await zip.generateAsync({ type: "arraybuffer" }),
    );

    expect(content.media.size).toBe(0);
    expect(getFileList(content)).toContain("word/media/image1.emf");
  });

  test("preserves large vector image entries without extracting them", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    zip.file("word/media/image1.emf", new Uint8Array(26 * 1024 * 1024));

    const content = await unzipDocx(
      await zip.generateAsync({
        compression: "DEFLATE",
        type: "arraybuffer",
      }),
    );

    expect(content.media.size).toBe(0);
    expect(getFileList(content)).toContain("word/media/image1.emf");
  });
});

function truncateAfterEndOfCentralDirectoryCounts(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return bytes.slice(0, offset + 12).buffer;
    }
  }

  throw new Error("Could not find ZIP end-of-central-directory record");
}

const getRejectedError = async (promise: Promise<unknown>) =>
  promise.then(() => null).catch((error: unknown) => error);
