import { PDFiumLibrary } from "@hyzyla/pdfium";
import { PDF } from "@libpdf/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { readImageHeader } from "@/api/lib/files/image-header";
import { imageToPdf } from "@/api/lib/files/image-pdf";
import { splitJpeg, splitPng } from "@/api/tests/helpers/image-fixtures";

let pdfium: PDFiumLibrary;

beforeAll(async () => {
  pdfium = await PDFiumLibrary.init();
});

afterAll(() => {
  pdfium.destroy();
});

type Rendered = {
  pageWidth: number;
  pageHeight: number;
  colorAt: (fx: number, fy: number) => readonly [number, number, number];
};

/** Render the only page and sample colours at fractional positions (top-left origin). */
const renderOnlyPage = async (pdfBytes: Uint8Array): Promise<Rendered> => {
  const document = await pdfium.loadDocument(Buffer.from(pdfBytes));
  expect(document.getPageCount()).toBe(1);
  const page = document.getPage(0);
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const render = await page.render({ scale: 1, render: "bitmap" });
  document.destroy();
  return {
    pageWidth: originalWidth,
    pageHeight: originalHeight,
    colorAt: (fx, fy) => {
      const x = Math.floor(render.width * fx);
      const y = Math.floor(render.height * fy);
      const index = (y * render.width + x) * 4;
      return [
        render.data[index] ?? 0,
        render.data[index + 1] ?? 0,
        render.data[index + 2] ?? 0,
      ];
    },
  };
};

const isRed = ([r, g, b]: readonly [number, number, number]) =>
  r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]: readonly [number, number, number]) =>
  b > 200 && r < 60 && g < 60;

describe("image to PDF without a browser", () => {
  test("a PNG becomes one page sized to the image, pixels intact", async () => {
    const png = splitPng(64, 32);
    const header = readImageHeader(png, "image/png");
    expect(header).toMatchObject({ width: 64, height: 32, orientation: 1 });
    if (header === null) {
      return;
    }

    const pdf = await imageToPdf({ bytes: png, header, mimeType: "image/png" });

    const rendered = await renderOnlyPage(pdf);
    expect(rendered.pageWidth).toBeCloseTo(48, 3);
    expect(rendered.pageHeight).toBeCloseTo(24, 3);
    expect(isRed(rendered.colorAt(0.25, 0.5))).toBe(true);
    expect(isBlue(rendered.colorAt(0.75, 0.5))).toBe(true);
  });

  test("a JPEG is stored as-is (DCT) in a one-page PDF sized to the image", async () => {
    const jpeg = await splitJpeg(64, 32, 1);
    const header = readImageHeader(jpeg, "image/jpeg");
    expect(header).toMatchObject({ width: 64, height: 32, orientation: 1 });
    if (header === null) {
      return;
    }

    const pdf = await imageToPdf({
      bytes: jpeg,
      header,
      mimeType: "image/jpeg",
    });

    const loaded = await PDF.load(pdf);
    expect(loaded.getPages()).toHaveLength(1);
    expect(new TextDecoder("latin1").decode(pdf)).toContain("/DCTDecode");
    const rendered = await renderOnlyPage(pdf);
    expect(rendered.pageWidth).toBeCloseTo(48, 3);
    expect(rendered.pageHeight).toBeCloseTo(24, 3);
    expect(isRed(rendered.colorAt(0.25, 0.5))).toBe(true);
    expect(isBlue(rendered.colorAt(0.75, 0.5))).toBe(true);
  });

  // Stored image: left half red, right half blue (64 x 32). Where each half
  // lands once the EXIF orientation is applied, as a viewer displays it.
  const ORIENTED = [
    { orientation: 1, size: [48, 24], red: [0.25, 0.5], blue: [0.75, 0.5] },
    { orientation: 2, size: [48, 24], red: [0.75, 0.5], blue: [0.25, 0.5] },
    { orientation: 3, size: [48, 24], red: [0.75, 0.5], blue: [0.25, 0.5] },
    { orientation: 4, size: [48, 24], red: [0.25, 0.5], blue: [0.75, 0.5] },
    { orientation: 5, size: [24, 48], red: [0.5, 0.25], blue: [0.5, 0.75] },
    { orientation: 6, size: [24, 48], red: [0.5, 0.25], blue: [0.5, 0.75] },
    { orientation: 7, size: [24, 48], red: [0.5, 0.75], blue: [0.5, 0.25] },
    { orientation: 8, size: [24, 48], red: [0.5, 0.75], blue: [0.5, 0.25] },
  ] as const;

  test.each(ORIENTED)(
    "EXIF orientation $orientation is applied to the page",
    async ({ orientation, size, red, blue }) => {
      const jpeg = await splitJpeg(64, 32, orientation);
      const header = readImageHeader(jpeg, "image/jpeg");
      expect(header?.orientation).toBe(orientation);
      if (header === null) {
        return;
      }

      const rendered = await renderOnlyPage(
        await imageToPdf({ bytes: jpeg, header, mimeType: "image/jpeg" }),
      );

      expect(rendered.pageWidth).toBeCloseTo(size[0], 3);
      expect(rendered.pageHeight).toBeCloseTo(size[1], 3);
      expect(isRed(rendered.colorAt(red[0], red[1]))).toBe(true);
      expect(isBlue(rendered.colorAt(blue[0], blue[1]))).toBe(true);
    },
  );
});
