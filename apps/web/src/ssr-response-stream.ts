import { panic, Result, TaggedError } from "better-result";

import { createDetached } from "@stll/errors";

const SSR_STREAM_LIFETIME_MS = 15_000;

export class SsrStreamTimeoutError extends TaggedError(
  "SsrStreamTimeoutError",
)<{
  message: string;
}> {}

const unavailableSsrResponse = () =>
  new Response("<!doctype html><html><head></head><body></body></html>", {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });

type BoundedSsrResponseOptions = {
  request: Request;
  fetchResponse: (request: Request) => Promise<Response>;
  reportError: (error: unknown) => void;
  lifetimeMs?: number;
};

export const fetchBoundedSsrResponse = async ({
  request,
  fetchResponse,
  reportError,
  lifetimeMs = SSR_STREAM_LIFETIME_MS,
}: BoundedSsrResponseOptions): Promise<Response> => {
  const started = performance.now();
  const renderer = new AbortController();
  const signal = AbortSignal.any([request.signal, renderer.signal]);
  // Document GETs may arrive from Vite's Request realm, which the runtime's
  // constructor cannot recognize as a Request input.
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal,
  });
  const detached = createDetached(reportError);
  const abort = Promise.withResolvers<unknown>();
  const onAbort = () => abort.resolve(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  const timeout = setTimeout(
    () =>
      renderer.abort(
        new SsrStreamTimeoutError({
          message: "Server-rendered HTML exceeded its response lifetime",
        }),
      ),
    lifetimeMs,
  );
  const fetched = Result.tryPromise({
    try: () => fetchResponse(boundedRequest),
    catch: (error) => error,
  }).then((result) => {
    if (signal.aborted && result.isOk() && result.value.body) {
      detached(
        result.value.body.cancel(signal.reason),
        "ssr.cancel-late-response",
      );
    }
    return { type: "response", result } as const;
  });
  const outcome = await Promise.race([
    fetched,
    abort.promise.then((error) => ({ type: "aborted", error }) as const),
  ]);
  clearTimeout(timeout);
  signal.removeEventListener("abort", onAbort);
  switch (outcome.type) {
    case "aborted":
      reportError(outcome.error);
      return unavailableSsrResponse();
    case "response": {
      if (outcome.result.isErr()) {
        renderer.abort(outcome.result.error);
        reportError(outcome.result.error);
        return unavailableSsrResponse();
      }
      const response = outcome.result.value;
      const isHtml =
        response.headers
          .get("Content-Type")
          ?.split(";")
          .at(0)
          ?.trim()
          .toLowerCase() === "text/html";
      if (!isHtml || !response.body) {
        return response;
      }
      const headers = new Headers(response.headers);
      // The bounded stream may finish after only the shell was produced.
      headers.delete("Content-Length");
      return new Response(
        boundSsrStream({
          source: response.body,
          signal,
          reportError,
          abortRenderer: (error) => renderer.abort(error),
          lifetimeMs: Math.max(0, lifetimeMs - (performance.now() - started)),
        }),
        {
          headers,
          status: response.status,
          statusText: response.statusText,
        },
      );
    }
    default: {
      outcome satisfies never;
      return panic(`Unhandled SSR response outcome: ${String(outcome)}`);
    }
  }
};

type BoundedSsrStreamOptions = {
  source: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  reportError: (error: unknown) => void;
  abortRenderer: (error: unknown) => void;
  lifetimeMs?: number;
};

// Closing a failed HTML response lets the browser reach DOMContentLoaded and
// hydrate the shell. Waiting for renderer cancellation can itself hang, so it
// must never own downstream completion.
export const boundSsrStream = ({
  source,
  signal,
  reportError,
  abortRenderer,
  lifetimeMs = SSR_STREAM_LIFETIME_MS,
}: BoundedSsrStreamOptions): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  const detached = createDetached(reportError);
  let terminal = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    signal.removeEventListener("abort", onAbort);
  };

  const cancelSource = (reason: unknown) => {
    detached(reader.cancel(reason), "ssr.cancel-renderer");
    reader.releaseLock();
  };

  const fail = (error: unknown) => {
    if (terminal) {
      return;
    }
    terminal = true;
    cleanup();
    controller.close();
    abortRenderer(error);
    cancelSource(error);
    reportError(error);
  };

  const onAbort = () => fail(signal.reason);

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(
        () =>
          fail(
            new SsrStreamTimeoutError({
              message: "Server-rendered HTML exceeded its stream lifetime",
            }),
          ),
        lifetimeMs,
      );
      if (signal.aborted) {
        onAbort();
      }
    },
    async pull() {
      if (terminal) {
        return;
      }
      const read = await Result.tryPromise({
        try: () => reader.read(),
        catch: (error) => error,
      });
      if (terminal) {
        return;
      }
      if (read.isErr()) {
        fail(read.error);
        return;
      }
      if (read.value.done) {
        terminal = true;
        cleanup();
        reader.releaseLock();
        controller.close();
        return;
      }
      controller.enqueue(read.value.value);
    },
    cancel(reason) {
      if (terminal) {
        return;
      }
      terminal = true;
      cleanup();
      abortRenderer(reason);
      cancelSource(reason);
    },
  });
};
