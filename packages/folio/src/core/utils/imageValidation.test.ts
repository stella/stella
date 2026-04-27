import { describe, expect, test } from "bun:test";

import { isAllowedImageMimeType, isSafeImageFile } from "./imageValidation";

describe("imageValidation", () => {
  test("allows only raster image MIME types used by Folio", () => {
    expect(isAllowedImageMimeType("image/png")).toBe(true);
    expect(isAllowedImageMimeType("image/jpeg")).toBe(true);
    expect(isAllowedImageMimeType("image/tiff")).toBe(true);
    expect(isAllowedImageMimeType("image/svg+xml")).toBe(false);
    expect(isAllowedImageMimeType("text/html")).toBe(false);
  });

  test("accepts files whose MIME type matches their signature", async () => {
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00])],
      "image.png",
      { type: "image/png" },
    );

    expect(await isSafeImageFile(file)).toBe(true);
  });

  test("accepts TIFF files whose MIME type matches their signature", async () => {
    const file = new File(
      [new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00])],
      "scan.tiff",
      { type: "image/tiff" },
    );

    expect(await isSafeImageFile(file)).toBe(true);
  });

  test("rejects files whose MIME type and signature do not match", async () => {
    const file = new File(
      [new Uint8Array([0x3c, 0x73, 0x76, 0x67])],
      "image.png",
      { type: "image/png" },
    );

    expect(await isSafeImageFile(file)).toBe(false);
  });
});
