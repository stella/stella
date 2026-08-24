import { PDF, rgb } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { isPageTransformRequest } from "./page-editor-protocol";
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
    const first = await PDF.load(outputs[0]!);
    const second = await PDF.load(outputs[1]!);
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
    const pdf = await PDF.load(output!);
    const crop = pdf.getPage(0)?.getCropBox();
    expect(crop?.x).toBeCloseTo(20);
    expect(crop?.y).toBeCloseTo(60);
    // LibPDF 0.4.1 exposes x2/y2 through these two fields; convert back to
    // dimensions when asserting the actual CropBox size.
    expect((crop?.width ?? 0) - (crop?.x ?? 0)).toBeCloseTo(100);
    expect((crop?.height ?? 0) - (crop?.y ?? 0)).toBeCloseTo(180);
  });
});
