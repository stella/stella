import { PDF, rgb } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import type { DocumentOcrPayload } from "@/api/lib/document-processing-contract";
import { createOcrSearchablePdf } from "@/api/lib/ocr-searchable-pdf";

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

describe("searchable PDF derivatives", () => {
  test("preserves the page and adds selectable Czech and Polish text", async () => {
    const source = PDF.create();
    const page = source.addPage({ width: 600, height: 800 });
    page.drawRectangle({
      x: 40,
      y: 680,
      width: 300,
      height: 40,
      color: rgb(0.9, 0.9, 0.9),
    });
    const sourceBytes = await source.save();
    const sourceSnapshot = sourceBytes.slice();
    const payload: DocumentOcrPayload = {
      version: 1,
      pages: [
        {
          width: 1200,
          height: 1600,
          lines: [
            {
              box: [80, 160, 680, 240],
              confidence: 0.99,
              text: "Příliš žluťoučký kůň",
            },
            {
              box: [80, 260, 760, 340],
              confidence: 0.98,
              text: "Zażółć gęślą jaźń",
            },
          ],
        },
      ],
    };

    const result = await createOcrSearchablePdf(
      toArrayBuffer(sourceBytes),
      payload,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(sourceBytes).toEqual(sourceSnapshot);
    const derivative = await PDF.load(result.value);
    const derivativePage = derivative.getPages().at(0);
    expect(derivativePage?.width).toBe(600);
    expect(derivativePage?.height).toBe(800);
    expect(derivativePage?.extractText().text).toContain(
      "Příliš žluťoučký kůň",
    );
    expect(derivativePage?.extractText().text).toContain("Zażółć gęślą jaźń");
  });

  test("does not duplicate text on a page that already has a native layer", async () => {
    const source = PDF.create();
    const page = source.addPage({ width: 600, height: 800 });
    page.drawText("Native text", { x: 40, y: 700, size: 18 });
    const payload: DocumentOcrPayload = {
      version: 1,
      pages: [
        {
          width: 1200,
          height: 1600,
          lines: [
            {
              box: [80, 160, 680, 240],
              confidence: 0.99,
              text: "Duplicate OCR text",
            },
          ],
        },
      ],
    };

    const result = await createOcrSearchablePdf(
      toArrayBuffer(await source.save()),
      payload,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    const derivative = await PDF.load(result.value);
    const extracted = derivative.getPages().at(0)?.extractText().text ?? "";
    expect(extracted).toContain("Native text");
    expect(extracted).not.toContain("Duplicate OCR text");
  });

  test("keeps supported text when another OCR line uses an unavailable glyph", async () => {
    const source = PDF.create();
    source.addPage({ width: 600, height: 800 });
    const payload: DocumentOcrPayload = {
      version: 1,
      pages: [
        {
          width: 1200,
          height: 1600,
          lines: [
            {
              box: [80, 160, 680, 240],
              confidence: 0.99,
              text: "Searchable Latin text",
            },
            {
              box: [80, 260, 760, 340],
              confidence: 0.98,
              text: "法律",
            },
          ],
        },
      ],
    };

    const result = await createOcrSearchablePdf(
      toArrayBuffer(await source.save()),
      payload,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    const derivative = await PDF.load(result.value);
    const extracted = derivative.getPages().at(0)?.extractText().text ?? "";
    expect(extracted).toContain("Searchable Latin text");
    expect(extracted).not.toContain("法律");
  });
});
