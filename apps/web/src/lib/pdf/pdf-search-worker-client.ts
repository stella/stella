import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { PDFSearchResult } from "@/lib/pdf/pdf-search";

type PDFSearchWorkerRequest = {
  bytes: ArrayBuffer;
  password?: string | undefined;
  searchText: string;
};

type PDFSearchWorkerResponse =
  | { status: "error"; message: string }
  | { status: "success"; result: PDFSearchResult | null };

type FindPDFSearchResultsInWorkerOptions = PDFSearchWorkerRequest & {
  signal: AbortSignal;
};

const abortError = () => new DOMException("PDF search cancelled", "AbortError");

export const findPDFSearchResultsInWorker = async ({
  bytes,
  password,
  searchText,
  signal,
}: FindPDFSearchResultsInWorkerOptions): Promise<PDFSearchResult | null> => {
  if (signal.aborted) {
    throw abortError();
  }

  const worker = new Worker(
    new URL("../../workers/pdf-search-worker.ts", import.meta.url),
    { type: "module" },
  );

  return new Promise((resolve, reject) => {
    let handleAbort: (() => void) | null = null;
    const dispose = () => {
      if (handleAbort) {
        signal.removeEventListener("abort", handleAbort);
      }
      worker.terminate();
    };
    handleAbort = () => {
      dispose();
      reject(abortError());
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    worker.addEventListener(
      "message",
      (event: MessageEvent<PDFSearchWorkerResponse>) => {
        dispose();
        if (event.data.status === "success") {
          resolve(event.data.result);
          return;
        }
        reject(
          new PDFViewerError({
            code: "LOAD_FAILED",
            message: event.data.message,
          }),
        );
      },
      { once: true },
    );
    worker.addEventListener(
      "error",
      (event) => {
        dispose();
        const cause: unknown = event.error;
        reject(
          new PDFViewerError({
            code: "LOAD_FAILED",
            message: "PDF search worker failed",
            cause,
          }),
        );
      },
      { once: true },
    );

    const request: PDFSearchWorkerRequest = {
      bytes,
      searchText,
      ...(password !== undefined && { password }),
    };
    const sendRequest = worker.postMessage.bind(worker);
    sendRequest(request, [bytes]);
  });
};
