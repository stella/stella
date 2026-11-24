import { panic, Result, TaggedError } from "better-result";

import { createDetached } from "@stll/errors";

const SSR_STREAM_LIFETIME_MS = 15_000;
const SSR_ABORT_DRAIN_MS = 1000;

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

/**
 * How a body ends when its renderer was cut off by the deadline and then
 * finished its recovery instructions: `close` completes it normally; `error`
 * still forwards every byte but then fails the transfer, so a shared cache
 * never stores the degraded document.
 */
export type SsrDeadlineEnding = "close" | "error";

type BoundedSsrResponseOptions = {
  request: Request;
  fetchResponse: (
    request: Request,
    rendererSignal: AbortSignal,
  ) => Promise<Response>;
  reportError: (error: unknown) => void;
  lifetimeMs?: number;
  /** Decided from the response's headers, before its body is sent. */
  deadlineEnding?: (response: Response) => SsrDeadlineEnding;
};

export const fetchBoundedSsrResponse = async ({
  request,
  fetchResponse,
  reportError,
  lifetimeMs = SSR_STREAM_LIFETIME_MS,
  deadlineEnding = () => "close",
}: BoundedSsrResponseOptions): Promise<Response> => {
  const started = performance.now();
  const renderer = new AbortController();
  // Start's request abort disposes hydration scripts and the response. After
  // the shell exists, only abort React so its recovery instructions can drain.
  const startup = new AbortController();
  const signal = AbortSignal.any([request.signal, startup.signal]);
  const rendererSignal = AbortSignal.any([request.signal, renderer.signal]);
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
  const timeout = setTimeout(() => {
    const error = new SsrStreamTimeoutError({
      message: "Server-rendered HTML exceeded its response lifetime",
    });
    startup.abort(error);
    renderer.abort(error);
  }, lifetimeMs);
  const fetched = Result.tryPromise({
    try: async () => fetchResponse(boundedRequest, rendererSignal),
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
      // A stream can fail after headers are sent; never cache a partial document.
      // The server entry alone may share an anonymous public document, and it
      // asks for `deadlineEnding: "error"` there: a body that failed or was
      // cut off by the deadline then ends in an error, which a shared cache
      // never stores.
      headers.set("Cache-Control", "private, no-store");
      headers.delete("Content-Length");
      return new Response(
        boundSsrStream({
          source: response.body,
          signal: request.signal,
          reportError,
          abortRenderer: (error) => renderer.abort(error),
          lifetimeMs: Math.max(0, lifetimeMs - (performance.now() - started)),
          deadlineEnding: deadlineEnding(response),
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
  drainMs?: number;
  deadlineEnding?: SsrDeadlineEnding;
};

// React aborts pending boundaries by emitting client-render instructions.
// Keep forwarding those bytes briefly, but never await producer cancellation
// to finish the HTTP response.
export const boundSsrStream = ({
  source,
  signal,
  reportError,
  abortRenderer,
  lifetimeMs = SSR_STREAM_LIFETIME_MS,
  drainMs = SSR_ABORT_DRAIN_MS,
  deadlineEnding = "close",
}: BoundedSsrStreamOptions): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  const detached = createDetached(reportError);
  let phase: "rendering" | "draining" | "closed" = "rendering";
  const isClosed = () => phase === "closed";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadlineError: SsrStreamTimeoutError | undefined;
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

  const fail = (error: unknown, disposeSource = cancelSource) => {
    if (isClosed()) {
      return;
    }
    phase = "closed";
    cleanup();
    controller.error(error);
    abortRenderer(error);
    disposeSource(error);
    reportError(error);
  };

  const onAbort = () => fail(signal.reason);

  const drain = () => {
    if (phase !== "rendering") {
      return;
    }
    phase = "draining";
    cleanup();
    const error = new SsrStreamTimeoutError({
      message: "Server-rendered HTML exceeded its stream lifetime",
    });
    deadlineError = error;
    timeout = setTimeout(() => {
      if (isClosed()) {
        return;
      }
      phase = "closed";
      cleanup();
      controller.error(error);
      cancelSource(error);
    }, drainMs);
    // The phase and drain deadline are installed before aborting: React may
    // synchronously resume the pending read with its recovery instructions.
    abortRenderer(error);
    reportError(error);
    if (!signal.aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(drain, lifetimeMs);
      if (signal.aborted) {
        onAbort();
      }
    },
    async pull() {
      if (isClosed()) {
        return;
      }
      const read = await Result.tryPromise({
        try: async () => reader.read(),
        catch: (error) => error,
      });
      if (isClosed()) {
        return;
      }
      if (read.isErr()) {
        fail(read.error, () => reader.releaseLock());
        return;
      }
      if (read.value.done) {
        phase = "closed";
        cleanup();
        reader.releaseLock();
        if (deadlineError !== undefined && deadlineEnding === "error") {
          controller.error(deadlineError);
          return;
        }
        controller.close();
        return;
      }
      controller.enqueue(read.value.value);
    },
    cancel(reason) {
      if (isClosed()) {
        return;
      }
      phase = "closed";
      cleanup();
      abortRenderer(reason);
      cancelSource(reason);
    },
  });
};
