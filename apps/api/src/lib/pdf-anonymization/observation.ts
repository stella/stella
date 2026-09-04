import type { PdfPageObservation } from "@stll/anonymize-pdf";

import type { DocumentOcrPage } from "@/api/lib/document-processing-contract";

export const pdfAnonymizationObservation = ({
  page,
  pageIndex,
}: {
  page: DocumentOcrPage;
  pageIndex: number;
}): PdfPageObservation => {
  let text = "";
  const glyphs: PdfPageObservation["glyphs"][number][] = [];
  for (const line of page.lines) {
    if (text.length > 0) {
      text += "\n";
    }
    const start = text.length;
    text += line.text;
    glyphs.push({
      start,
      end: text.length,
      bounds: {
        left: Math.min(line.box[0], page.width),
        bottom: Math.max(0, page.height - line.box[3]),
        right: Math.min(line.box[2], page.width),
        top: Math.max(0, page.height - line.box[1]),
      },
      source: "ocr",
    });
  }
  return {
    pageIndex,
    widthPoints: page.width,
    heightPoints: page.height,
    text,
    glyphs,
    rendered: true,
    textLayer: "absent",
    ocr: "complete",
    imageCount: 0,
  };
};
