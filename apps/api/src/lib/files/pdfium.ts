/**
 * The one module that calls PDFium.
 *
 * PDFium runs as WASM with a manually managed heap: the document bytes must
 * stay allocated until the document closes, every page and bitmap handle
 * must be released, and `HEAPU8` must be re-read after any allocation
 * because heap growth replaces the underlying buffer. Keeping those rules
 * in one place is why callers get plain typed results instead of handles.
 *
 * The WASM loads from `pdfium.wasm` beside the importing bundle (the
 * package's `new URL(..., import.meta.url)` lookup), so a bundled worker
 * ships it as a sidecar; see `RUNTIME_WORKER_SIDECAR_FILES`.
 */
/// <reference types="emscripten" />
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { Result, TaggedError } from "better-result";

const FPDF_RENDER_ANNOT = 0x01;
const FPDF_LCD_TEXT = 0x02;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
// Distinct bits, so the sum is their union. REVERSE_BYTE_ORDER makes PDFium
// write RGBA instead of BGRA.
const RENDER_FLAGS =
  FPDF_RENDER_ANNOT + FPDF_LCD_TEXT + FPDF_REVERSE_BYTE_ORDER;
const FPDF_BITMAP_BGRA = 4;
const RGBA_BYTES_PER_PIXEL = 4;
const OPAQUE_WHITE = 0xff_ff_ff_ff;

const PDFIUM_OPERATIONS = {
  allocate: "allocate",
  loadDocument: "load-document",
  loadPage: "load-page",
} as const;

export class PdfiumError extends TaggedError("PdfiumError")<{
  message: string;
  operation: (typeof PDFIUM_OPERATIONS)[keyof typeof PDFIUM_OPERATIONS];
  /** `FPDF_GetLastError()` after the failed call; 0 when PDFium set none. */
  code: number;
}> {}

let pdfiumModule: Promise<WrappedPdfiumModule> | undefined;

const getPdfium = async (): Promise<WrappedPdfiumModule> => {
  pdfiumModule ??= init({}).then((module) => {
    module.PDFiumExt_Init();
    return module;
  });
  return await pdfiumModule;
};

const allocate = (
  pdfium: WrappedPdfiumModule,
  size: number,
): Result<number, PdfiumError> => {
  const pointer = pdfium.pdfium.wasmExports.malloc(size);
  return pointer === 0
    ? Result.err(
        new PdfiumError({
          message: `PDFium could not allocate ${size} bytes`,
          operation: PDFIUM_OPERATIONS.allocate,
          code: 0,
        }),
      )
    : Result.ok(pointer);
};

type PageAccess = {
  pdfium: WrappedPdfiumModule;
  document: number;
  index: number;
};

const withPage = <T>(
  { pdfium, document, index }: PageAccess,
  read: (page: number) => Result<T, PdfiumError>,
): Result<T, PdfiumError> => {
  const page = pdfium.FPDF_LoadPage(document, index);
  if (page === 0) {
    return Result.err(
      new PdfiumError({
        message: `PDFium could not load page ${index}`,
        operation: PDFIUM_OPERATIONS.loadPage,
        code: pdfium.FPDF_GetLastError(),
      }),
    );
  }
  try {
    return read(page);
  } finally {
    pdfium.FPDF_ClosePage(page);
  }
};

type RenderPageOptions = {
  index: number;
  /** Bitmap size in pixels; the page is scaled to fill it. */
  width: number;
  height: number;
};

export const openPdfiumDocument = async (bytes: Uint8Array) => {
  const pdfium = await getPdfium();
  const { wasmExports } = pdfium.pdfium;
  const allocated = allocate(pdfium, bytes.length);
  if (allocated.isErr()) {
    return Result.err(allocated.error);
  }
  const bytesPointer = allocated.value;
  pdfium.pdfium.HEAPU8.set(bytes, bytesPointer);
  const document = pdfium.FPDF_LoadMemDocument(bytesPointer, bytes.length, "");
  if (document === 0) {
    const code = pdfium.FPDF_GetLastError();
    wasmExports.free(bytesPointer);
    return Result.err(
      new PdfiumError({
        message: "PDFium could not load the document",
        operation: PDFIUM_OPERATIONS.loadDocument,
        code,
      }),
    );
  }

  /** PDF points, after the page's `/Rotate`. */
  const pageSize = (index: number) =>
    withPage({ pdfium, document, index }, (page) =>
      Result.ok({
        pointWidth: pdfium.FPDF_GetPageWidthF(page),
        pointHeight: pdfium.FPDF_GetPageHeightF(page),
      }),
    );

  /** Row-major RGBA, `width * height * 4` bytes, on an opaque white page. */
  const renderPage = ({ index, width, height }: RenderPageOptions) =>
    withPage({ pdfium, document, index }, (page) => {
      const stride = width * RGBA_BYTES_PER_PIXEL;
      const pixels = allocate(pdfium, stride * height);
      if (pixels.isErr()) {
        return Result.err(pixels.error);
      }
      const bitmap = pdfium.FPDFBitmap_CreateEx(
        width,
        height,
        FPDF_BITMAP_BGRA,
        pixels.value,
        stride,
      );
      try {
        pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, OPAQUE_WHITE);
        pdfium.FPDF_RenderPageBitmap(
          bitmap,
          page,
          0,
          0,
          width,
          height,
          0,
          RENDER_FLAGS,
        );
        return Result.ok({
          rgba: pdfium.pdfium.HEAPU8.slice(
            pixels.value,
            pixels.value + stride * height,
          ),
          width,
          height,
        });
      } finally {
        pdfium.FPDFBitmap_Destroy(bitmap);
        wasmExports.free(pixels.value);
      }
    });

  return Result.ok({
    pageCount: pdfium.FPDF_GetPageCount(document),
    pageSize,
    renderPage,
    close: () => {
      pdfium.FPDF_CloseDocument(document);
      wasmExports.free(bytesPointer);
    },
  });
};
