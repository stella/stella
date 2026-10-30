import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { NumberedPageSearchText } from "@/lib/pdf/pdf-search";

export type PDFPageTextWorkerRequest = {
  bytes: ArrayBuffer;
  pageNumbers: readonly number[];
};

export type PDFPageTextWorkerResponse =
  | { status: "error"; message: string }
  | { status: "success"; pages: NumberedPageSearchText[] };

type ExtractPDFPageSearchTextsInWorkerOptions = PDFPageTextWorkerRequest & {
  signal: AbortSignal;
};

const abortError = () =>
  new DOMException("PDF page text extraction cancelled", "AbortError");

/**
 * The search text of the given pages, extracted off the main thread: LibPDF
 * parses the whole document, which a long PDF must not cost the UI thread.
 * One worker per call, ended when it answers or the call is aborted. The
 * bytes are transferred, so callers pass a copy they no longer need.
 */
export const extractPDFPageSearchTextsInWorker = async ({
  bytes,
  pageNumbers,
  signal,
}: ExtractPDFPageSearchTextsInWorkerOptions): Promise<
  NumberedPageSearchText[]
> =>
  await new Promise<NumberedPageSearchText[]>((resolve, reject) => {
    // A call made after its signal aborted settles like an abort mid-call,
    // without starting a worker.
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(
      new URL("../../workers/pdf-page-text-worker.ts", import.meta.url),
      { type: "module" },
    );
    const controller = new AbortController();
    const dispose = () => {
      controller.abort();
      worker.terminate();
    };
    signal.addEventListener(
      "abort",
      () => {
        dispose();
        reject(abortError());
      },
      { once: true, signal: controller.signal },
    );
    worker.addEventListener(
      "message",
      (event: MessageEvent<PDFPageTextWorkerResponse>) => {
        dispose();
        if (event.data.status === "success") {
          resolve(event.data.pages);
          return;
        }
        reject(
          new PDFViewerError({
            code: "LOAD_FAILED",
            message: event.data.message,
          }),
        );
      },
      { once: true, signal: controller.signal },
    );
    worker.addEventListener(
      "error",
      (event) => {
        dispose();
        const cause: unknown = event.error;
        reject(
          new PDFViewerError({
            code: "LOAD_FAILED",
            message: "PDF page text worker failed",
            cause,
          }),
        );
      },
      { once: true, signal: controller.signal },
    );
    const request: PDFPageTextWorkerRequest = { bytes, pageNumbers };
    const sendRequest = worker.postMessage.bind(worker);
    sendRequest(request, [bytes]);
  });
