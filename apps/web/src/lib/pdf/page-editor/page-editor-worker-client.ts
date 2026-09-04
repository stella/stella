import { ClientOperationError } from "@/lib/errors/client";

import {
  isPageTransformResponseForRequest,
  type PageTransformRequest,
  type PageTransformSource,
} from "./page-editor-protocol";

let nextRequestId = 0;

const abortError = () =>
  new DOMException("PDF transformation cancelled", "AbortError");

export const transformPDFInWorker = async ({
  sources,
  pages,
  outputs,
  signal,
}: Omit<PageTransformRequest, "requestId" | "sources"> & {
  sources: readonly PageTransformSource[];
  signal: AbortSignal;
}): Promise<ArrayBuffer[]> => {
  if (signal.aborted) {
    throw abortError();
  }
  const worker = new Worker(
    new URL("../../../workers/pdf-page-editor-worker.ts", import.meta.url),
    { type: "module" },
  );
  nextRequestId += 1;
  const requestId = nextRequestId;
  const request: PageTransformRequest = {
    requestId,
    pages,
    outputs: outputs.map((output) => [...output]),
    sources: sources.map((source) => ({
      id: source.id,
      bytes: source.bytes.slice(0),
    })),
  };
  return await new Promise<ArrayBuffer[]>((resolve, reject) => {
    const dispose = () => {
      signal.removeEventListener("abort", handleAbort);
      worker.terminate();
    };
    const handleAbort = () => {
      dispose();
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isPageTransformResponseForRequest(event.data, requestId)) {
        dispose();
        reject(
          new ClientOperationError({
            action: "transform-pdf-pages",
            message: "PDF transformation worker returned an invalid response",
          }),
        );
        return;
      }
      dispose();
      if (event.data.status === "success") {
        resolve(event.data.outputs);
      } else {
        reject(
          new ClientOperationError({
            action: "transform-pdf-pages",
            message: event.data.message,
          }),
        );
      }
    });
    worker.addEventListener(
      "error",
      () => {
        dispose();
        reject(
          new ClientOperationError({
            action: "transform-pdf-pages",
            message: "PDF transformation worker failed",
          }),
        );
      },
      { once: true },
    );
    const transferables = request.sources.map((source) => source.bytes);
    worker.postMessage(request, transferables);
  });
};
