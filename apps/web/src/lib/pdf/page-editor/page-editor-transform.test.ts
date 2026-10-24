import {
  PDF,
  PdfDict,
  PdfName,
  PdfNumber,
  PdfRef,
  PdfStream,
  rgb,
} from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import type { PageCleanScan } from "./clean-scan-placement";
import { isPageTransformRequest } from "./page-editor-protocol";
import type { PagePlanEntry } from "./page-editor-protocol";
import { transformPagePlan } from "./page-editor-transform";

const sourceBytes = async (): Promise<Uint8Array> => {
  const pdf = PDF.create();
  for (const label of ["one", "two", "three"]) {
    const page = pdf.addPage({ width: 200, height: 300 });
    page.drawText(label, { x: 20, y: 260, size: 12, color: rgb(0, 0, 0) });
  }
  return pdf.save();
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

describe("page transformation plans", () => {
  test("rejects malformed worker input at the protocol boundary", () => {
    expect(
      isPageTransformRequest({
        requestId: 1,
        sources: [],
        pages: [],
        outputs: [[]],
      }),
    ).toBe(false);
  });

  test("reorders, removes, duplicates, rotates, and splits without mutating sources", async () => {
    const bytes = await sourceBytes();
    const snapshot = bytes.slice();
    const outputs = await transformPagePlan({
      sources: [{ id: "source", bytes: toArrayBuffer(bytes) }],
      pages: [
        { id: "one", sourceId: "source", sourcePageIndex: 0, rotation: 0 },
        { id: "two", sourceId: "source", sourcePageIndex: 1, rotation: 90 },
        { id: "three", sourceId: "source", sourcePageIndex: 2, rotation: 0 },
      ],
      outputs: [["three", "two", "two"], ["one"]],
    });

    expect(bytes).toEqual(snapshot);
    expect(outputs).toHaveLength(2);
    const firstOutput = outputs.at(0);
    const secondOutput = outputs.at(1);
    if (!firstOutput || !secondOutput) {
      throw new Error("Expected two transformed outputs");
    }
    const first = await PDF.load(firstOutput);
    const second = await PDF.load(secondOutput);
    expect(first.getPageCount()).toBe(3);
    expect(second.getPageCount()).toBe(1);
    expect(first.getPage(1)?.rotation).toBe(90);
  });

  test("applies normalized crop to a copied page", async () => {
    const bytes = await sourceBytes();
    const [output] = await transformPagePlan({
      sources: [{ id: "source", bytes: toArrayBuffer(bytes) }],
      pages: [
        {
          id: "cropped",
          sourceId: "source",
          sourcePageIndex: 0,
          rotation: 0,
          crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
        },
      ],
      outputs: [["cropped"]],
    });
    if (!output) {
      throw new Error("Expected one transformed output");
    }
    const pdf = await PDF.load(output);
    const crop = pdf.getPage(0)?.getCropBox();
    expect(crop?.x).toBeCloseTo(20);
    expect(crop?.y).toBeCloseTo(60);
    // LibPDF 0.4.1 exposes x2/y2 through these two fields; convert back to
    // dimensions when asserting the actual CropBox size.
    expect((crop?.width ?? 0) - (crop?.x ?? 0)).toBeCloseTo(100);
    expect((crop?.height ?? 0) - (crop?.y ?? 0)).toBeCloseTo(180);
  });

  test.each([
    { rotation: 90 as const, x: 0.2, y: 0.1, width: 0.6, height: 0.7 },
    { rotation: 180 as const, x: 0.2, y: 0.2, width: 0.7, height: 0.6 },
    { rotation: 270 as const, x: 0.2, y: 0.2, width: 0.6, height: 0.7 },
  ])(
    "maps a visual left-edge crop through a $rotation-degree rotation",
    async ({ height, rotation, width, x, y }) => {
      const bytes = await sourceBytes();
      const [output] = await transformPagePlan({
        sources: [{ id: "source", bytes: toArrayBuffer(bytes) }],
        pages: [
          {
            id: "cropped",
            sourceId: "source",
            sourcePageIndex: 0,
            rotation,
            crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
          },
        ],
        outputs: [["cropped"]],
      });
      if (!output) {
        throw new Error("Expected one transformed output");
      }
      const pdf = await PDF.load(output);
      const crop = pdf.getPage(0)?.getCropBox();
      expect(crop?.x).toBeCloseTo(200 * x);
      expect(crop?.y).toBeCloseTo(300 * y);
      expect((crop?.width ?? 0) - (crop?.x ?? 0)).toBeCloseTo(200 * width);
      expect((crop?.height ?? 0) - (crop?.y ?? 0)).toBeCloseTo(300 * height);
    },
  );
});

describe("cleaned scan pages", () => {
  // 120 × 180 px at 144 DPI is 60 × 90 pt: smaller than the 200 × 300 pt
  // source page, so it keeps its physical size and is centred.
  const cleanScan = (format: "grayscale" | "binary") =>
    ({
      image: {
        pixels: new Uint8Array(120 * 180).fill(format === "binary" ? 255 : 200),
        width: 120,
        height: 180,
        format,
      },
      pageSize: { widthPoints: 200, heightPoints: 300 },
      dpi: 144,
    }) satisfies PageCleanScan;

  type CleanedOutputOptions = {
    crop?: PagePlanEntry["crop"];
    rotation: PagePlanEntry["rotation"];
    scan: PageCleanScan;
  };

  const cleanedOutput = async ({
    crop,
    rotation,
    scan,
  }: CleanedOutputOptions) => {
    const bytes = await sourceBytes();
    const page = {
      id: "cleaned",
      sourceId: "source",
      sourcePageIndex: 1,
      rotation,
      scan,
      ...(crop === undefined ? {} : { crop }),
    } satisfies PagePlanEntry;
    const request = {
      requestId: 1,
      sources: [{ id: "source", bytes: toArrayBuffer(bytes) }],
      pages: [page],
      outputs: [["cleaned"]],
    };
    expect(isPageTransformRequest(request)).toBe(true);
    const [output] = await transformPagePlan(request);
    if (!output) {
      throw new Error("Expected one transformed output");
    }
    const pdf = await PDF.load(output);
    const emitted = pdf.getPage(0);
    if (!emitted) {
      throw new Error("Expected one emitted page");
    }
    return { pdf, page: emitted };
  };

  const embeddedImage = (
    pdf: PDF,
    page: NonNullable<ReturnType<PDF["getPage"]>>,
  ) => {
    const resolve = (value: unknown) =>
      value instanceof PdfRef ? pdf.getObject(value) : value;
    const xObjects = resolve(page.getResources().get("XObject"));
    if (!(xObjects instanceof PdfDict)) {
      throw new Error("Expected an XObject resource dictionary");
    }
    const images = [...xObjects.keys()].map((key) =>
      resolve(xObjects.get(key)),
    );
    expect(images).toHaveLength(1);
    const [image] = images;
    if (!(image instanceof PdfStream)) {
      throw new Error("Expected an image stream");
    }
    const number = (key: string) => {
      const value = image.get(key);
      return value instanceof PdfNumber ? value.value : null;
    };
    const name = (key: string) => {
      const value = image.get(key);
      return value instanceof PdfName ? value.value : null;
    };
    return {
      bitsPerComponent: number("BitsPerComponent"),
      colorSpace: name("ColorSpace"),
      height: number("Height"),
      subtype: name("Subtype"),
      width: number("Width"),
      decodedBytes: image.getDecodedData().byteLength,
    };
  };

  test.each([0, 90, 180, 270] as const)(
    "emits the applied page on the source page box at %i degrees",
    async (rotation) => {
      const { pdf, page } = await cleanedOutput({
        rotation,
        scan: cleanScan("grayscale"),
      });
      const box = page.getMediaBox();

      expect(page.rotation).toBe(rotation);
      expect(box.x).toBe(0);
      expect(box.y).toBe(0);
      // LibPDF exposes the upper-right corner through width/height.
      expect(box.width - box.x).toBeCloseTo(200);
      expect(box.height - box.y).toBeCloseTo(300);
      expect(embeddedImage(pdf, page)).toEqual({
        bitsPerComponent: 8,
        colorSpace: "DeviceGray",
        height: 180,
        subtype: "Image",
        width: 120,
        decodedBytes: 120 * 180,
      });
    },
  );

  test("packs a binary scan to one bit per pixel", async () => {
    const { pdf, page } = await cleanedOutput({
      rotation: 0,
      scan: cleanScan("binary"),
    });

    expect(embeddedImage(pdf, page)).toMatchObject({
      bitsPerComponent: 1,
      colorSpace: "DeviceGray",
      decodedBytes: (120 / 8) * 180,
    });
  });

  test("still applies the page crop to a cleaned page", async () => {
    const { page } = await cleanedOutput({
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      rotation: 0,
      scan: cleanScan("grayscale"),
    });
    const crop = page.getCropBox();

    expect(crop.x).toBeCloseTo(20);
    expect(crop.y).toBeCloseTo(60);
    expect(crop.width - crop.x).toBeCloseTo(100);
    expect(crop.height - crop.y).toBeCloseTo(180);
  });

  test("rejects a cleaned image whose pixels do not match its size", () => {
    const scan = cleanScan("grayscale");
    expect(
      isPageTransformRequest({
        requestId: 1,
        sources: [{ id: "source", bytes: new ArrayBuffer(8) }],
        pages: [
          {
            id: "cleaned",
            sourceId: "source",
            sourcePageIndex: 0,
            rotation: 0,
            scan: {
              ...scan,
              image: { ...scan.image, pixels: new Uint8Array(10) },
            },
          },
        ],
        outputs: [["cleaned"]],
      }),
    ).toBe(false);
  });
});
