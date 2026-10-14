/// <reference lib="webworker" />

import { panic } from "better-result";

import type {
  PDFPageTextWorkerRequest,
  PDFPageTextWorkerResponse,
} from "@/lib/pdf/pdf-page-text-worker-client";
import { extractPDFPageSearchTexts } from "@/lib/pdf/pdf-search";

const isDedicatedWorkerScope = (
  value: typeof globalThis,
): value is typeof globalThis & DedicatedWorkerGlobalScope =>
  "importScripts" in value && "WorkerGlobalScope" in globalThis;

if (!isDedicatedWorkerScope(globalThis)) {
  panic("PDF page text extraction must run in a dedicated worker");
}

const sendResponse = globalThis.postMessage.bind(globalThis);

const handle = async (
  request: PDFPageTextWorkerRequest,
): Promise<PDFPageTextWorkerResponse> => {
  try {
    const pages = await extractPDFPageSearchTexts({
      bytes: new Uint8Array(request.bytes),
      pageNumbers: request.pageNumbers,
      // The client ends this worker to cancel, so nothing aborts in here.
      signal: new AbortController().signal,
    });
    return { status: "success", pages };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

globalThis.addEventListener(
  "message",
  (event: MessageEvent<PDFPageTextWorkerRequest>) => {
    handle(event.data)
      .then((response) => {
        sendResponse(response);
        return undefined;
      })
      .catch((error: unknown) => {
        sendResponse({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        } satisfies PDFPageTextWorkerResponse);
      });
  },
);
