import { PDFiumLibrary } from "@hyzyla/pdfium";

import {
  inspectPdf,
  PDF_RASTER_MAX_OUTPUT_BYTES,
  PDF_RASTER_MAX_PAGE_BYTES,
  PDF_RASTER_MAX_TOTAL_BYTES,
  rewritePdfRasterFromDetections,
  type PdfRasterPage,
  type PdfRasterProvider,
} from "@stll/anonymize-pdf";

import {
  DOCUMENT_OCR_PROCESSOR_VERSION,
  OCR_MAX_PAGES,
  OCR_RENDER_MAX_SIDE_PIXELS,
  OCR_RENDER_TARGET_SCALE,
} from "@/api/lib/document-processing-contract";
import { rgbaToRgb } from "@/api/lib/ocr-local/rgb-image";
import {
  PDF_ANONYMIZATION_OCR_LANGUAGE,
  PDF_ANONYMIZATION_PIPELINE_VERSION,
} from "@/api/lib/pdf-anonymization/contract";
import { pdfAnonymizationObservation } from "@/api/lib/pdf-anonymization/observation";
import {
  decodePdfAnonymizationWorkerRequest,
  encodePdfAnonymizationWorkerResponse,
} from "@/api/lib/pdf-anonymization/worker-protocol";

const PROVIDER = {
  providerId: "stella-pdfium-ppocr-local",
  rendererName: "Stella PDFium renderer",
  rendererVersion: String(PDF_ANONYMIZATION_PIPELINE_VERSION),
  ocrName: "PP-OCRv5 mobile Latin",
  ocrVersion: String(DOCUMENT_OCR_PROCESSOR_VERSION),
  ocrLanguage: PDF_ANONYMIZATION_OCR_LANGUAGE,
} as const satisfies PdfRasterProvider;

const die = (message: string): never => {
  process.stderr.write(`pdf-anonymization-worker error: ${message}\n`);
  process.exit(1);
};

try {
  const input = decodePdfAnonymizationWorkerRequest(
    new Uint8Array(await Bun.stdin.arrayBuffer()),
  );
  if (
    input.document.byteLength === 0 ||
    input.pages.length < 1 ||
    input.pages.length > OCR_MAX_PAGES
  ) {
    die("input outside supported limits");
  }

  // Parse untrusted PDF structure only in this bounded subprocess.
  const inspection = inspectPdf(input.document);
  if (inspection.encrypted || inspection.pageCount !== input.pages.length) {
    die("source PDF is encrypted or does not match the OCR pages");
  }
  const library = await PDFiumLibrary.init();
  const document = await library.loadDocument(Buffer.from(input.document));
  const pageCount = document.getPageCount();
  if (pageCount !== input.pages.length) {
    die("OCR page count does not match the source PDF");
  }

  const pages: {
    pixels: Uint8Array;
    page: PdfRasterPage;
  }[] = [];
  // Leave room for pixel rounding while keeping long documents within the
  // native rewrite's aggregate allocation limit.
  const pagePixelBudget = Math.floor(
    Math.min(
      PDF_RASTER_MAX_PAGE_BYTES,
      PDF_RASTER_MAX_TOTAL_BYTES / pageCount,
    ) / 3,
  );
  let totalPixelBytes = 0;
  for (const [pageIndex, observed] of input.pages.entries()) {
    const page = document.getPage(pageIndex);
    const { originalHeight: pointHeight, originalWidth: pointWidth } =
      page.getOriginalSize();
    if (
      pointWidth !== observed.ocr.width ||
      pointHeight !== observed.ocr.height
    ) {
      die("OCR page geometry does not match the source PDF");
    }
    const scale = Math.min(
      OCR_RENDER_TARGET_SCALE,
      OCR_RENDER_MAX_SIDE_PIXELS / Math.max(pointWidth, pointHeight),
      Math.sqrt(pagePixelBudget / (pointWidth * pointHeight)) * 0.99,
    );
    // eslint-disable-next-line no-await-in-loop -- PDFium shares one document heap; rendering pages sequentially bounds peak memory.
    const render = await page.render({ scale });
    totalPixelBytes += render.width * render.height * 3;
    if (totalPixelBytes > PDF_RASTER_MAX_TOTAL_BYTES) {
      die("rendered pages exceed their aggregate limit");
    }
    const pixels = rgbaToRgb({
      data: render.data,
      width: render.width,
      height: render.height,
    });
    pages.push({
      pixels,
      page: {
        observation: pdfAnonymizationObservation({
          page: observed.ocr,
          pageIndex,
        }),
        widthPixels: render.width,
        heightPixels: render.height,
        pixelSha256: new Bun.CryptoHasher("sha256")
          .update(pixels)
          .digest("hex"),
        detections: observed.detections,
      },
    });
  }
  document.destroy();
  library.destroy();

  const sourceSha256 = new Bun.CryptoHasher("sha256")
    .update(input.document)
    .digest("hex");
  const rewritten = rewritePdfRasterFromDetections({
    document: input.document,
    request: {
      contractVersion: 1,
      sourceSha256,
      provider: PROVIDER,
      fillRgb: [0, 0, 0],
      pages: pages.map(({ page }) => page),
    },
    pagePixels: pages.map(({ pixels }) => pixels),
  });
  if (rewritten.document.byteLength > PDF_RASTER_MAX_OUTPUT_BYTES) {
    die("output exceeds its limit");
  }
  process.stdout.write(
    encodePdfAnonymizationWorkerResponse({
      certificate: rewritten.certificate,
      document: rewritten.document,
    }),
  );
  process.exit(0);
} catch (error) {
  const type = error instanceof Error ? error.constructor.name : "UnknownError";
  die(type);
}
