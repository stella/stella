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
    await expect(
      unzipDocx(new ArrayBuffer(2), { maxInputBytes: 1 }),
    ).rejects.toBeInstanceOf(DocxSecurityError);
  });

  test("rejects archives with too many file entries", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");

    await expect(
      unzipDocx(await zip.generateAsync({ type: "arraybuffer" }), {
        maxFiles: 1,
      }),
    ).rejects.toBeInstanceOf(DocxSecurityError);
  });

  test("rejects unsafe archive paths", async () => {
    const zip = new JSZip();
    zip.file("/word/document.xml", "<w:document />");

    await expect(
      unzipDocx(await zip.generateAsync({ type: "arraybuffer" })),
    ).rejects.toBeInstanceOf(DocxSecurityError);
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
});
