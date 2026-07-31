/// <reference lib="webworker" />

import { findPDFSearchResults } from "@/lib/pdf/pdf-search";

type PDFSearchWorkerRequest = {
  bytes: ArrayBuffer;
  password?: string | undefined;
  searchText: string;
};

type PDFSearchWorkerResponse =
  | { status: "error"; message: string }
  | {
      status: "success";
      result: Awaited<ReturnType<typeof findPDFSearchResults>>;
    };

const isDedicatedWorkerScope = (
  value: typeof globalThis,
): value is typeof globalThis & DedicatedWorkerGlobalScope =>
  "importScripts" in value && "WorkerGlobalScope" in globalThis;

if (!isDedicatedWorkerScope(globalThis)) {
  throw new TypeError("PDF search must run in a dedicated worker");
}

const scope = globalThis;
const sendResponse = scope.postMessage.bind(scope);

const handle = async (
  request: PDFSearchWorkerRequest,
): Promise<PDFSearchWorkerResponse> => {
  try {
    const result = await findPDFSearchResults({
      bytes: new Uint8Array(request.bytes),
      password: request.password,
      searchText: request.searchText,
      signal: new AbortController().signal,
    });
    return { status: "success", result };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

scope.addEventListener(
  "message",
  (event: MessageEvent<PDFSearchWorkerRequest>) => {
    handle(event.data)
      .then((response) => {
        sendResponse(response);
        return undefined;
      })
      .catch((error: unknown) => {
        sendResponse({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  },
);
