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
        left: line.box[0],
        bottom: page.height - line.box[3],
        right: line.box[2],
        top: page.height - line.box[1],
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
