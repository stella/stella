import { expect, test } from "bun:test";

import { pdfAnonymizationObservation } from "@/api/lib/pdf-anonymization/observation";

test("maps top-left OCR line boxes into bottom-left PDF observations", () => {
  expect(
    pdfAnonymizationObservation({
      pageIndex: 2,
      page: {
        width: 612,
        height: 792,
        lines: [
          { box: [10, 20, 80, 40], confidence: 0.9, text: "Jan" },
          { box: [10, 50, 100, 70], confidence: 0.8, text: "Novák" },
        ],
      },
    }),
  ).toEqual({
    pageIndex: 2,
    widthPoints: 612,
    heightPoints: 792,
    text: "Jan\nNovák",
    glyphs: [
      {
        start: 0,
        end: 3,
        bounds: { left: 10, bottom: 752, right: 80, top: 772 },
        source: "ocr",
      },
      {
        start: 4,
        end: 9,
        bounds: { left: 10, bottom: 722, right: 100, top: 742 },
        source: "ocr",
      },
    ],
    rendered: true,
    textLayer: "absent",
    ocr: "complete",
    imageCount: 0,
  });
});
