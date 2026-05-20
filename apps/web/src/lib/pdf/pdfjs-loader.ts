import type * as PDFJS from "pdfjs-dist";

import "@/lib/pdf/uint8array-to-hex-polyfill";

// eslint-disable-next-line import/default -- Vite ?url import returns the asset URL as default export
import pdfjsWorkerUrl from "./pdfjs-worker?worker&url";

let pdfjsInstance: typeof PDFJS | null = null;

export const loadPdfjs = async (): Promise<typeof PDFJS> => {
  if (pdfjsInstance) {
    return pdfjsInstance;
  }

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  pdfjsInstance = pdfjs;
  return pdfjs;
};

export type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
