/// <reference lib="webworker" />

import {
  isPageTransformRequest,
  type PageTransformResponse,
} from "@/lib/pdf/page-editor/page-editor-protocol";
import { transformPagePlan } from "@/lib/pdf/page-editor/page-editor-transform";

const requestIdOf = (value: unknown): number =>
  typeof value === "object" &&
  value !== null &&
  "requestId" in value &&
  typeof value.requestId === "number"
    ? value.requestId
    : -1;

const handle = async (request: unknown): Promise<PageTransformResponse> => {
  try {
    if (!isPageTransformRequest(request)) {
      return {
        requestId: requestIdOf(request),
        status: "error",
        message: "Invalid PDF edit request",
      };
    }
    const outputs = await transformPagePlan(request);
    const transferableOutputs = outputs.map((bytes) => {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    });
    return {
      requestId: request.requestId,
      status: "success",
      outputs: transferableOutputs,
    };
  } catch {
    return {
      requestId: requestIdOf(request),
      status: "error",
      message: "PDF transformation failed",
    };
  }
};

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  handle(event.data)
    .then((response) => {
      globalThis.postMessage(
        response,
        response.status === "success" ? response.outputs : [],
      );
      return undefined;
    })
    .catch((error: unknown) => {
      globalThis.reportError(error);
      const response: PageTransformResponse = {
        requestId: requestIdOf(event.data),
        status: "error",
        message: "PDF transformation failed",
      };
      globalThis.postMessage(response, []);
    });
});
