/// <reference lib="webworker" />

import { findPDFSearchResults } from "@/lib/pdf/pdf-search";
import type {
  PDFSearchWorkerRequest,
  PDFSearchWorkerResponse,
} from "@/lib/pdf/pdf-search-worker-protocol";

const isDedicatedWorkerScope = (
  value: typeof globalThis,
): value is typeof globalThis & DedicatedWorkerGlobalScope =>
  "importScripts" in value && "WorkerGlobalScope" in globalThis;

if (!isDedicatedWorkerScope(globalThis)) {
  throw new TypeError("PDF search must run in a dedicated worker");
}

const scope = globalThis;
const sendResponse = scope.postMessage.bind(scope);
let activeController: AbortController | null = null;

const handle = async (
  request: PDFSearchWorkerRequest,
  signal: AbortSignal,
): Promise<PDFSearchWorkerResponse> => {
  try {
    const result = await findPDFSearchResults({
      bytes: new Uint8Array(request.bytes),
      password: request.password,
      searchText: request.searchText,
      signal,
    });
    return { status: "success", requestId: request.requestId, result };
  } catch (error) {
    return {
      status: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

scope.addEventListener(
  "message",
  (event: MessageEvent<PDFSearchWorkerRequest>) => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    handle(event.data, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) {
          return undefined;
        }
        sendResponse(response);
        return undefined;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        sendResponse({
          status: "error",
          requestId: event.data.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  },
);
