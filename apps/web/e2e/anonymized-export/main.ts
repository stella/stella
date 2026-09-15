import { PDF, rgb } from "@libpdf/core";

import { rasterizeAnonymizedPdf } from "../../src/lib/pdf/anonymized-export";
import {
  buildAnonymizedExportMasks,
  extractAnonymizedExportText,
} from "../../src/lib/pdf/anonymized-export.logic";
import type { PDFSearchBox } from "../../src/lib/pdf/pdf-search";
import { toPDFSearchViewportBox } from "../../src/lib/pdf/pdf-search";
import { loadPdfjs } from "../../src/lib/pdf/pdfjs-loader";
import type { PDFDocumentProxy } from "../../src/lib/pdf/pdfjs-loader";

const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 160;
const RENDER_SCALE = 2;
const MASK_PADDING_PT = 1;
const PRIVATE_AUTHOR = "Privileged author";
const PRIVATE_TITLE = "Privileged matter title";
const PRIVATE_ATTACHMENT = "Privileged attachment contents";
const PRIVATE_TERMS = ["Secret Person", "secret@example.test"] as const;

type PagePixelResult = {
  blackMaskPixelRatio: number;
  height: number;
  visualMeanAbsoluteError: number;
  width: number;
};

type AnonymizedExportCheck = {
  output: {
    attachmentCount: number;
    metadata: ReturnType<PDF["getMetadata"]>;
    pageCount: number;
    pageRotations: number[];
    text: string;
  };
  pixels: PagePixelResult[];
  source: {
    attachmentCount: number;
    metadata: ReturnType<PDF["getMetadata"]>;
    pageCount: number;
    pageRotations: number[];
    text: string;
  };
};

declare global {
  // oxlint-disable-next-line consistent-type-definitions -- global Window augmentation requires interface declaration merging
  interface Window {
    runAnonymizedExportCheck: () => Promise<AnonymizedExportCheck>;
    runUnsupportedExportCheck: () => Promise<boolean[]>;
  }
}

const paddedBox = ({ x, y, width, height }: PDFSearchBox): PDFSearchBox => ({
  x: x - MASK_PADDING_PT,
  y: y - MASK_PADDING_PT,
  width: width + MASK_PADDING_PT * 2,
  height: height + MASK_PADDING_PT * 2,
});

const renderPage = async (
  pdfDocument: PDFDocumentProxy,
  pageNumber: number,
) => {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new TypeError("Expected a 2D canvas context");
  }
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return { canvas, context, page, viewport };
};

const readPixel = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): [number, number, number, number] => {
  const pixel = context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
};

window.runAnonymizedExportCheck = async () => {
  const source = PDF.create();
  source.setAuthor(PRIVATE_AUTHOR);
  source.setTitle(PRIVATE_TITLE);
  source.addAttachment(
    "privileged.txt",
    new TextEncoder().encode(PRIVATE_ATTACHMENT),
  );
  for (const rotation of [0, 90] as const) {
    const page = source.addPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    page.setRotation(rotation);
    page.drawText("Public clause: Secret Person, retained wording.", {
      x: 20,
      y: 100,
      size: 14,
    });
    page.drawText("Contact: secret@example.test", { x: 20, y: 60, size: 14 });
    page.drawText("PUBLIC", {
      x: 330,
      y: 20,
      size: 8,
      color: rgb(0.1, 0.75, 0.2),
    });
  }

  const input = await source.save();
  const parsedSource = await PDF.load(input);
  const extraction = extractAnonymizedExportText(parsedSource.getPages());
  const masks = buildAnonymizedExportMasks({
    extraction,
    terms: PRIVATE_TERMS,
  }).unwrap();
  const outputBytes = (
    await rasterizeAnonymizedPdf(Uint8Array.from(input).buffer, masks)
  ).unwrap();
  const output = await PDF.load(outputBytes);

  const pdfjs = await loadPdfjs();
  const sourceLoadingTask = pdfjs.getDocument({ data: input.slice() });
  const outputLoadingTask = pdfjs.getDocument({ data: outputBytes.slice() });
  const [sourceDocument, outputDocument] = await Promise.all([
    sourceLoadingTask.promise,
    outputLoadingTask.promise,
  ]);
  const pixels: PagePixelResult[] = [];
  try {
    for (
      let pageNumber = 1;
      pageNumber <= outputDocument.numPages;
      pageNumber += 1
    ) {
      const [sourceRender, outputRender] = await Promise.all([
        renderPage(sourceDocument, pageNumber),
        renderPage(outputDocument, pageNumber),
      ]);
      const maskRects = (masks.get(pageNumber - 1) ?? []).map((box) => {
        const rect = toPDFSearchViewportBox(
          paddedBox(box),
          sourceRender.viewport,
        );
        if (!rect) {
          throw new TypeError("Expected a redaction mask viewport rectangle");
        }
        return rect;
      });

      for (const rect of maskRects) {
        sourceRender.context.fillStyle = "#000000";
        sourceRender.context.fillRect(
          rect.left,
          rect.top,
          rect.width,
          rect.height,
        );
      }

      const expected = sourceRender.context.getImageData(
        0,
        0,
        sourceRender.canvas.width,
        sourceRender.canvas.height,
      ).data;
      const actual = outputRender.context.getImageData(
        0,
        0,
        outputRender.canvas.width,
        outputRender.canvas.height,
      ).data;
      let totalDifference = 0;
      for (let index = 0; index < actual.length; index += 1) {
        totalDifference += Math.abs(
          (actual[index] ?? 0) - (expected[index] ?? 0),
        );
      }

      let blackPixels = 0;
      let maskPixels = 0;
      for (const rect of maskRects) {
        const left = Math.ceil(rect.left + 1);
        const top = Math.ceil(rect.top + 1);
        const right = Math.floor(rect.left + rect.width - 1);
        const bottom = Math.floor(rect.top + rect.height - 1);
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const [red, green, blue, alpha] = readPixel(
              outputRender.context,
              x,
              y,
            );
            maskPixels += 1;
            if (red < 8 && green < 8 && blue < 8 && alpha === 255) {
              blackPixels += 1;
            }
          }
        }
      }

      pixels.push({
        blackMaskPixelRatio: blackPixels / maskPixels,
        height: outputRender.canvas.height,
        visualMeanAbsoluteError: totalDifference / actual.length,
        width: outputRender.canvas.width,
      });
      sourceRender.page.cleanup();
      outputRender.page.cleanup();
    }
  } finally {
    await Promise.all([
      sourceLoadingTask.destroy(),
      outputLoadingTask.destroy(),
    ]);
  }

  return {
    output: {
      attachmentCount: output.getAttachments().size,
      metadata: output.getMetadata(),
      pageCount: output.getPageCount(),
      pageRotations: output.getPages().map((page) => page.rotation),
      text: output
        .extractText()
        .map((page) => page.text)
        .join(""),
    },
    pixels,
    source: {
      attachmentCount: parsedSource.getAttachments().size,
      metadata: parsedSource.getMetadata(),
      pageCount: parsedSource.getPageCount(),
      pageRotations: parsedSource.getPages().map((page) => page.rotation),
      text: parsedSource
        .extractText()
        .map((page) => page.text)
        .join("\n"),
    },
  };
};

window.runUnsupportedExportCheck = async () => {
  const results: boolean[] = [];
  for (const content of ["image", "path"] as const) {
    const pdf = PDF.create();
    const page = pdf.addPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    page.drawText("Extractable public text", { x: 20, y: 100, size: 14 });
    if (content === "path") {
      page.drawRectangle({
        x: 20,
        y: 20,
        width: 80,
        height: 20,
        color: rgb(0, 0, 0),
      });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 40;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new TypeError("Expected canvas context");
      }
      context.fillText("Sensitive raster text", 5, 20);
      const png = await (
        await fetch(canvas.toDataURL("image/png"))
      ).arrayBuffer();
      const image = pdf.embedPng(new Uint8Array(png));
      page.drawImage(image, { x: 20, y: 20, width: 160, height: 40 });
    }
    const bytes = await pdf.save();
    const result = await rasterizeAnonymizedPdf(
      Uint8Array.from(bytes).buffer,
      new Map(),
    );
    results.push(result.isErr());
  }
  return results;
};
