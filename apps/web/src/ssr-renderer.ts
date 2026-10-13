import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import type { AnyRouter } from "@tanstack/react-router";
import {
  createSsrStreamResponse,
  getSsrStatus,
  transformReadableStreamWithRouter,
  waitForRequest,
} from "@tanstack/react-router/ssr/server";
import { isbot } from "isbot";

type SsrRenderOptions = {
  request: Request;
  rendererSignal: AbortSignal;
  router: AnyRouter;
  responseHeaders: Headers;
  children: ReactNode;
  reportError: (error: unknown) => void;
};

export const renderSsrResponse = async ({
  request,
  rendererSignal,
  router,
  responseHeaders,
  children,
  reportError,
}: SsrRenderOptions) => {
  try {
    request.signal.throwIfAborted();
    const stream = await renderToReadableStream(children, {
      signal: rendererSignal,
      nonce: router.options.ssr?.nonce,
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onError: reportError,
    });
    const responseStream = transformReadableStreamWithRouter(router, stream, {
      // A rendering deadline leaves the transform alive to forward React's
      // client-render instructions; a disconnected caller cancels both.
      signal: request.signal,
      rendererSafePoint: "script-close",
    });
    if (isbot(request.headers.get("User-Agent"))) {
      await waitForRequest(stream.allReady, rendererSignal);
    }
    return createSsrStreamResponse(
      router,
      new Response(responseStream, {
        status: getSsrStatus(router),
        headers: responseHeaders,
      }),
    );
  } catch (error) {
    router.serverSsr?.cleanup();
    throw error;
  }
};
