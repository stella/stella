import { PDF, rgb } from "@libpdf/core";

import { extractPdfAnonymizationText } from "../../src/lib/anonymize/pdf-anonymization-geometry";
import { rasterizeAnonymizedPdf } from "../../src/lib/pdf/anonymized-export";
import { buildAnonymizedExportMasks } from "../../src/lib/pdf/anonymized-export.logic";
import {
  manualRedactionFromDrag,
  pdfDocumentKey,
} from "../../src/lib/pdf/manual-redaction.logic";
import type {
  ManualRedactionArea,
  ManualRedactionExport,
} from "../../src/lib/pdf/manual-redaction.logic";
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
// No detection finds this; only the area drawn over it can hide it.
const UNDETECTED_SECRET = "Undetected 4711";
const READER_SCALE = 1.5;

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

type ScreenRect = { left: number; top: number; right: number; bottom: number };

type ManualRedactionExportCheck = {
  areaCount: number;
  outputText: string;
  sourceText: string;
  /** Per page: black share of the secret's pixels before and after export. */
  secretBlackRatio: { source: number; output: number }[];
  /** Per drawn area: black share of its pixels in the exported page. */
  areaBlackRatio: number[];
  otherDocumentError: string | null;
  otherPageSizeError: string | null;
};

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- global Window augmentation requires interface declaration merging
  interface Window {
    runAnonymizedExportCheck: () => Promise<AnonymizedExportCheck>;
    runUnsupportedExportCheck: () => Promise<boolean[]>;
    runExportLimitCheck: (options: {
      pageCount: number;
      pageSize: number;
    }) => Promise<string | null>;
    showManualRedactionPages: () => Promise<ScreenRect[]>;
    runManualRedactionExportCheck: () => Promise<ManualRedactionExportCheck>;
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
  const extraction = extractPdfAnonymizationText(parsedSource.getPages());
  const masks = buildAnonymizedExportMasks({
    extraction,
    terms: PRIVATE_TERMS,
  }).unwrap();
  const outputBytes = (
    await rasterizeAnonymizedPdf({
      buffer: Uint8Array.from(input).buffer,
      masks,
      manualRedaction: null,
    })
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
        await fetch(canvas.toDataURL("image/png"), {
          signal: AbortSignal.timeout(10_000),
        })
      ).arrayBuffer();
      const image = pdf.embedPng(new Uint8Array(png));
      page.drawImage(image, { x: 20, y: 20, width: 160, height: 40 });
    }
    const bytes = await pdf.save();
    const result = await rasterizeAnonymizedPdf({
      buffer: Uint8Array.from(bytes).buffer,
      masks: new Map(),
      manualRedaction: null,
    });
    results.push(result.isErr());
  }
  return results;
};

window.runExportLimitCheck = async ({ pageCount, pageSize }) => {
  const pdf = PDF.create();
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage({ width: pageSize, height: pageSize });
  }
  const bytes = await pdf.save();
  const result = await rasterizeAnonymizedPdf({
    buffer: Uint8Array.from(bytes).buffer,
    masks: new Map(),
    manualRedaction: null,
  });
  return result.isErr() ? result.error.message : null;
};

const blackRatio = (
  context: CanvasRenderingContext2D,
  rect: { left: number; top: number; width: number; height: number },
) => {
  // One pixel in from each edge: antialiasing blends the boundary.
  const left = Math.ceil(rect.left + 1);
  const top = Math.ceil(rect.top + 1);
  const right = Math.floor(rect.left + rect.width - 1);
  const bottom = Math.floor(rect.top + rect.height - 1);
  let black = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const [red, green, blue, alpha] = readPixel(context, x, y);
      total += 1;
      if (red < 8 && green < 8 && blue < 8 && alpha === 255) {
        black += 1;
      }
    }
  }
  return black / total;
};

/** The viewport rectangle spanning every glyph box. */
const unionViewportRect = (
  boxes: readonly PDFSearchBox[],
  viewport: Parameters<typeof toPDFSearchViewportBox>[1],
) => {
  const rects = boxes.map((box) => {
    const rect = toPDFSearchViewportBox(box, viewport);
    if (!rect) {
      throw new TypeError("Expected a viewport rectangle");
    }
    return rect;
  });
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  return {
    left,
    top,
    width: Math.max(...rects.map((rect) => rect.left + rect.width)) - left,
    height: Math.max(...rects.map((rect) => rect.top + rect.height)) - top,
  };
};

const buildManualRedactionSource = async () => {
  const source = PDF.create();
  for (const rotation of [0, 90] as const) {
    const page = source.addPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    page.setRotation(rotation);
    page.drawText("Public clause, retained wording.", {
      x: 20,
      y: 100,
      size: 14,
    });
    page.drawText(UNDETECTED_SECRET, { x: 20, y: 60, size: 14 });
  }
  return await source.save();
};

let manualRedactionSource: Uint8Array | null = null;
const drawnAreas: ManualRedactionArea[] = [];

/**
 * Shows the pages as the reader does and takes drags the way its marking
 * surface does, so the test can draw areas with the mouse. Returns where the
 * undetected secret sits on screen, per page.
 */
window.showManualRedactionPages = async () => {
  const input = await buildManualRedactionSource();
  manualRedactionSource = input;
  drawnAreas.length = 0;
  const secretBoxes = buildAnonymizedExportMasks({
    extraction: extractPdfAnonymizationText((await PDF.load(input)).getPages()),
    terms: [UNDETECTED_SECRET],
  }).unwrap();
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: input.slice() });
  const pdfDocument = await loadingTask.promise;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:16px;align-items:flex-start;";
  document.body.append(row);
  const rects: ScreenRect[] = [];
  try {
    for (
      let pageNumber = 1;
      pageNumber <= pdfDocument.numPages;
      pageNumber += 1
    ) {
      const page = await pdfDocument.getPage(pageNumber);
      const pageSize = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: READER_SCALE });
      const container = document.createElement("div");
      container.style.cssText = `position:relative;width:${viewport.width}px;height:${viewport.height}px;`;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;";
      const context = canvas.getContext("2d");
      if (!context) {
        throw new TypeError("Expected a 2D canvas context");
      }
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const surface = document.createElement("div");
      surface.style.cssText = "position:absolute;inset:0;touch-action:none;";
      let start: { x: number; y: number } | null = null;
      surface.addEventListener("pointerdown", (event) => {
        surface.setPointerCapture(event.pointerId);
        start = { x: event.clientX, y: event.clientY };
      });
      surface.addEventListener("pointerup", (event) => {
        if (start === null) {
          return;
        }
        const bounds = surface.getBoundingClientRect();
        const region = manualRedactionFromDrag({
          pageIndex: pageNumber - 1,
          start,
          end: { x: event.clientX, y: event.clientY },
          pageRect: {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
          },
        });
        start = null;
        if (region !== null) {
          drawnAreas.push({
            ...region,
            id: `area-${drawnAreas.length}`,
            pageWidth: pageSize.width,
            pageHeight: pageSize.height,
          });
        }
      });
      container.append(canvas, surface);
      row.append(container);

      const bounds = container.getBoundingClientRect();
      const secret = unionViewportRect(
        secretBoxes.get(pageNumber - 1) ?? [],
        viewport,
      );
      rects.push({
        left: bounds.left + secret.left,
        top: bounds.top + secret.top,
        right: bounds.left + secret.left + secret.width,
        bottom: bounds.top + secret.top + secret.height,
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return rects;
};

window.runManualRedactionExportCheck = async () => {
  const input = manualRedactionSource;
  if (input === null) {
    throw new TypeError("Show the pages before exporting");
  }
  const pdfjs = await loadPdfjs();
  const sourceLoadingTask = pdfjs.getDocument({ data: input.slice() });
  const sourceDocument = await sourceLoadingTask.promise;
  const documentKey = pdfDocumentKey(sourceDocument.fingerprints);
  const areas = [...drawnAreas];
  const exportWith = async (manualRedaction: ManualRedactionExport) =>
    await rasterizeAnonymizedPdf({
      buffer: Uint8Array.from(input).buffer,
      // Detection finds nothing: every black pixel comes from a drawn area.
      masks: new Map(),
      manualRedaction,
    });
  const outputBytes = (await exportWith({ documentKey, areas })).unwrap();
  const otherDocument = await exportWith({ documentKey: "other", areas });
  const otherPageSize = await exportWith({
    documentKey,
    areas: areas.map((area) => ({ ...area, pageWidth: area.pageWidth + 1 })),
  });
  const output = await PDF.load(outputBytes);
  const source = await PDF.load(input);
  const secretBoxes = buildAnonymizedExportMasks({
    extraction: extractPdfAnonymizationText(source.getPages()),
    terms: [UNDETECTED_SECRET],
  }).unwrap();

  const outputLoadingTask = pdfjs.getDocument({ data: outputBytes.slice() });
  const outputDocument = await outputLoadingTask.promise;
  const secretBlackRatio: ManualRedactionExportCheck["secretBlackRatio"] = [];
  const areaBlackRatio: number[] = [];
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
      // The output page is the source page as displayed, so the source
      // viewport places the secret on the output canvas too.
      const secret = unionViewportRect(
        secretBoxes.get(pageNumber - 1) ?? [],
        sourceRender.viewport,
      );
      secretBlackRatio.push({
        source: blackRatio(sourceRender.context, secret),
        output: blackRatio(outputRender.context, secret),
      });
      for (const area of areas) {
        if (area.pageIndex !== pageNumber - 1) {
          continue;
        }
        const { width, height } = outputRender.canvas;
        areaBlackRatio.push(
          blackRatio(outputRender.context, {
            left: area.left * width,
            top: area.top * height,
            width: (area.right - area.left) * width,
            height: (area.bottom - area.top) * height,
          }),
        );
      }
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
    areaCount: areas.length,
    outputText: output
      .extractText()
      .map((page) => page.text)
      .join(""),
    sourceText: source
      .extractText()
      .map((page) => page.text)
      .join("\n"),
    secretBlackRatio,
    areaBlackRatio,
    otherDocumentError: otherDocument.isErr()
      ? otherDocument.error.message
      : null,
    otherPageSizeError: otherPageSize.isErr()
      ? otherPageSize.error.message
      : null,
  };
};
