import { Result } from "better-result";

import { ClientOperationError } from "@/lib/errors/client";
import { hasUnsupportedAnonymizationContent } from "@/lib/pdf/anonymized-export-content.logic";
import { UnsupportedAnonymizedExportError } from "@/lib/pdf/anonymized-export-errors";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";
import { toPDFSearchViewportBox } from "@/lib/pdf/pdf-search";
import { loadPdfjs } from "@/lib/pdf/pdfjs-loader";

const EXPORT_SCALE = 2;
const MASK_PADDING_PT = 1;
const MAX_PAGE_PIXELS = 16_000_000;
const NO_MASKS: readonly PDFSearchBox[] = [];

export const rasterizeAnonymizedPdf = async (
  buffer: ArrayBuffer,
  masks: ReadonlyMap<number, readonly PDFSearchBox[]>,
) =>
  await Result.tryPromise({
    try: async () => {
      const [{ PDF }, pdfjs] = await Promise.all([
        import("@libpdf/core"),
        loadPdfjs(),
      ]);
      const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) });
      try {
        const pdfDocument = await loadingTask.promise;
        const output = PDF.create();
        // Rebuild from masked pixels only: copying source pages would preserve
        // covered text, annotations, attachments, and hidden document metadata.
        for (
          let pageNumber = 1;
          pageNumber <= pdfDocument.numPages;
          pageNumber += 1
        ) {
          const page = await pdfDocument.getPage(pageNumber);
          const operators = await page.getOperatorList({
            annotationMode: pdfjs.AnnotationMode.DISABLE,
          });
          if (
            hasUnsupportedAnonymizationContent(operators.fnArray, pdfjs.OPS)
          ) {
            return Result.err(
              new UnsupportedAnonymizedExportError({
                message:
                  "The file contains visual content that cannot be checked for sensitive text",
              }),
            );
          }
          const viewport = page.getViewport({ scale: EXPORT_SCALE });
          if (viewport.width * viewport.height > MAX_PAGE_PIXELS) {
            return Result.err(
              new ClientOperationError({
                action: "anonymized-export",
                message: "A page exceeds the anonymized export size limit",
              }),
            );
          }
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d");
          if (!context) {
            return Result.err(
              new ClientOperationError({
                action: "anonymized-export",
                message: "The browser could not create an export canvas",
              }),
            );
          }
          await page.render({
            canvas,
            canvasContext: context,
            viewport,
            annotationMode: pdfjs.AnnotationMode.DISABLE,
          }).promise;
          context.fillStyle = "#000000";
          for (const box of masks.get(pageNumber - 1) ?? NO_MASKS) {
            const rect = toPDFSearchViewportBox(
              {
                x: box.x - MASK_PADDING_PT,
                y: box.y - MASK_PADDING_PT,
                width: box.width + MASK_PADDING_PT * 2,
                height: box.height + MASK_PADDING_PT * 2,
              },
              viewport,
            );
            if (rect === null) {
              return Result.err(
                new ClientOperationError({
                  action: "anonymized-export",
                  message: "A redaction mask could not be positioned",
                }),
              );
            }
            context.fillRect(rect.left, rect.top, rect.width, rect.height);
          }
          const pixels = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) {
                resolve(blob);
              } else {
                reject(
                  new ClientOperationError({
                    action: "anonymized-export",
                    message: "The browser could not encode an export page",
                  }),
                );
              }
            }, "image/png");
          });
          const image = output.embedPng(
            new Uint8Array(await pixels.arrayBuffer()),
          );
          const width = viewport.width / EXPORT_SCALE;
          const height = viewport.height / EXPORT_SCALE;
          output
            .addPage({ width, height })
            .drawImage(image, { x: 0, y: 0, width, height });
          canvas.width = 0;
          canvas.height = 0;
          page.cleanup();
        }
        return Result.ok(await output.save());
      } finally {
        await loadingTask.destroy();
      }
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "anonymized-export",
        message: "The anonymized PDF could not be rendered",
        cause,
      }),
  }).then(Result.flatten);
