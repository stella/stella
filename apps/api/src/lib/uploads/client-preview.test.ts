import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  type ImageHeader,
  readImageHeader,
} from "@/api/lib/files/image-header";
import { LIMITS } from "@/api/lib/limits";
import {
  acceptsClientPreview,
  type ClientPreviewDeclaration,
  clientPreviewDeclarationSchema,
  clientPreviewRefusal,
  clientPreviewTmpKey,
} from "@/api/lib/uploads/client-preview";
import {
  heicFixture,
  splitJpeg,
  withHeifRotation,
} from "@/api/tests/helpers/image-fixtures";

const SHA = "a".repeat(64);

const declared = (
  width: number,
  height: number,
  mimeType: ClientPreviewDeclaration["mimeType"] = "image/jpeg",
): ClientPreviewDeclaration => ({
  mimeType,
  size: 1000,
  sha256Hex: SHA,
  width,
  height,
});

const header = (
  width: number,
  height: number,
  orientation: ImageHeader["orientation"] = 1,
): ImageHeader => ({ width, height, orientation });

/** The 48 MP fixture photo: 8064 x 6048, upright. */
const photo = () =>
  readImageHeader(heicFixture("grid-48mp.heic"), "image/heic");

describe("client preview declaration", () => {
  test("accepts a JPEG or WebP within the page-image budget", () => {
    for (const mimeType of ["image/jpeg", "image/webp"] as const) {
      expect(
        v.is(clientPreviewDeclarationSchema, declared(3264, 2448, mimeType)),
      ).toBe(true);
    }
  });

  test("refuses another type, more pixels than a page image, or a large file", () => {
    expect(
      v.is(clientPreviewDeclarationSchema, {
        ...declared(100, 100),
        mimeType: "image/png",
      }),
    ).toBe(false);
    expect(v.is(clientPreviewDeclarationSchema, declared(4000, 2001))).toBe(
      false,
    );
    expect(
      v.is(clientPreviewDeclarationSchema, {
        ...declared(100, 100),
        size: LIMITS.clientPreviewBytesMax + 1,
      }),
    ).toBe(false);
    expect(
      v.is(clientPreviewDeclarationSchema, {
        ...declared(100, 100),
        sha256Hex: "A".repeat(64),
      }),
    ).toBe(false);
  });

  test("only HEIC and HEIF photos carry one", () => {
    for (const mimeType of [
      "image/heic",
      "image/heif",
      "image/heic-sequence",
      "image/heif-sequence",
    ]) {
      expect(acceptsClientPreview(mimeType)).toBe(true);
    }
    for (const mimeType of ["image/jpeg", "application/pdf", "image/tiff"]) {
      expect(acceptsClientPreview(mimeType)).toBe(false);
    }
  });

  test("is staged beside the original, under the same tenant prefix", () => {
    expect(clientPreviewTmpKey("org/ws/tmp/upload")).toBe(
      "org/ws/tmp/upload-preview",
    );
  });
});

describe("whether a client preview stands for the photo", () => {
  test("a preview in the photo's shape, as declared, holds", async () => {
    const preview = readImageHeader(
      await splitJpeg(3264, 2448, 1),
      "image/jpeg",
    );
    expect(
      clientPreviewRefusal({
        declared: declared(3264, 2448),
        original: photo(),
        preview,
      }),
    ).toBeNull();
  });

  test("an EXIF-rotated preview is compared as it is shown", async () => {
    // Stored 2448 x 3264 and turned a quarter: shown 3264 x 2448.
    const preview = readImageHeader(
      await splitJpeg(2448, 3264, 6),
      "image/jpeg",
    );
    expect(
      clientPreviewRefusal({
        declared: declared(3264, 2448),
        original: photo(),
        preview,
      }),
    ).toBeNull();
  });

  test("a rotated photo is compared as it is shown", () => {
    // The 1100 x 700 grid turned a quarter shows 700 x 1100.
    const turned = readImageHeader(
      withHeifRotation(heicFixture("grid.heic"), 1),
      "image/heic",
    );
    expect(
      clientPreviewRefusal({
        declared: declared(700, 1100),
        original: turned,
        preview: header(700, 1100),
      }),
    ).toBeNull();
    expect(
      clientPreviewRefusal({
        declared: declared(1100, 700),
        original: turned,
        preview: header(1100, 700),
      }),
    ).toBe("shape-mismatch");
  });

  test.each([
    ["original-unreadable", null, header(3264, 2448), declared(3264, 2448)],
    ["preview-unreadable", header(8064, 6048), null, declared(3264, 2448)],
    // Its header disagrees with what the client declared.
    [
      "size-mismatch",
      header(8064, 6048),
      header(3264, 2440),
      declared(3264, 2448),
    ],
    // Another picture's shape.
    [
      "shape-mismatch",
      header(8064, 6048),
      header(2500, 2500),
      declared(2500, 2500),
    ],
    // A thumbnail cannot stand for the photo.
    ["too-small", header(8064, 6048), header(400, 300), declared(400, 300)],
    // More pixels than a page image, whatever was declared.
    ["too-large", header(8064, 6048), header(4000, 3000), declared(4000, 3000)],
  ] as const)("refuses %s", (reason, original, preview, declaration) => {
    expect(
      clientPreviewRefusal({ declared: declaration, original, preview }),
    ).toBe(reason);
  });

  test("a small photo may have a preview of its own size", () => {
    expect(
      clientPreviewRefusal({
        declared: declared(300, 200),
        original: header(300, 200),
        preview: header(300, 200),
      }),
    ).toBeNull();
  });

  test("a photo short on one side still needs its longer side shown in full up to 1024", () => {
    expect(
      clientPreviewRefusal({
        declared: declared(770, 490),
        original: header(1100, 700),
        preview: header(770, 490),
      }),
    ).toBe("too-small");
  });

  test("holds exactly when the preview has the photo's shape and fits the budget", () => {
    assertProperty(
      "holds exactly when the preview has the photo's shape and fits the budget",
      fc.property(
        fc.integer({ min: 64, max: 16_000 }),
        fc.integer({ min: 64, max: 16_000 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (photoWidth, photoHeight, width, height) => {
          const refusal = clientPreviewRefusal({
            declared: declared(width, height),
            original: header(photoWidth, photoHeight),
            preview: header(width, height),
          });
          const sameShape =
            Math.abs(width / height / (photoWidth / photoHeight) - 1) <= 0.01;
          const fits = width * height <= LIMITS.pdfRenderImagePixelsMax;
          const bigEnough =
            Math.max(width, height) >=
            Math.min(1024, Math.max(photoWidth, photoHeight));
          expect(refusal === null).toBe(sameShape && fits && bigEnough);
        },
      ),
      { numRuns: 300 },
    );
  });
});
