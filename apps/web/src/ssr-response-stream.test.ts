import { createElement, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server";

import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  boundSsrStream,
  fetchBoundedSsrResponse,
  SsrStreamTimeoutError,
} from "./ssr-response-stream";

const encoder = new TextEncoder();
const SHELL = "<html><body><main>Server shell</main>";

test("SSR responses return an unavailable document when the renderer never produces a shell", async () => {
  const errors: unknown[] = [];
  let producerSignal: AbortSignal | undefined;
  const response = await fetchBoundedSsrResponse({
    request: new Request("https://stella.test/law/cases"),
    fetchResponse: async (request) => {
      producerSignal = request.signal;
      return new Promise<Response>(() => {});
    },
    lifetimeMs: 10,
    reportError: (error) => {
      errors.push(error);
    },
  });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("</body></html>");
  expect(producerSignal?.aborted).toBe(true);
  expect(errors).toHaveLength(1);
  expect(errors.at(0)).toBeInstanceOf(SsrStreamTimeoutError);
});

test("SSR responses surface pre-shell render failures as unavailable HTML", async () => {
  const errors: unknown[] = [];
  const failure = new TypeError("Renderer failed before shell");
  const response = await fetchBoundedSsrResponse({
    request: new Request("https://stella.test/law/cases"),
    fetchResponse: async () => {
      throw failure;
    },
    reportError: (error) => {
      errors.push(error);
    },
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(errors).toEqual([failure]);
});

test("SSR responses release a renderer that resolves after the deadline", async () => {
  const late = Promise.withResolvers<Response>();
  const cancelled = Promise.withResolvers<unknown>();
  const errors: unknown[] = [];
  const response = await fetchBoundedSsrResponse({
    request: new Request("https://stella.test/law/cases"),
    fetchResponse: async () => late.promise,
    lifetimeMs: 10,
    reportError: (error) => {
      errors.push(error);
    },
  });
  expect(response.status).toBe(503);
  late.resolve(
    new Response(
      new ReadableStream({ cancel: (error) => cancelled.resolve(error) }),
    ),
  );
  expect(await cancelled.promise).toBe(errors.at(0));
});

test("SSR responses stop a pending renderer when the request aborts", async () => {
  const errors: unknown[] = [];
  const request = new AbortController();
  const reason = new DOMException("Request cancelled", "AbortError");
  const completion = fetchBoundedSsrResponse({
    request: new Request("https://stella.test/law/cases", {
      signal: request.signal,
    }),
    fetchResponse: async () => new Promise<Response>(() => {}),
    reportError: (error) => {
      errors.push(error);
    },
  });
  request.abort(reason);
  expect((await completion).status).toBe(503);
  expect(errors).toEqual([reason]);
});

test("SSR responses preserve successful documents and non-HTML responses", async () => {
  for (const contentType of ["text/html; charset=utf-8", "application/json"]) {
    const errors: unknown[] = [];
    const response = await fetchBoundedSsrResponse({
      request: new Request("https://stella.test/law/cases?q=fixture", {
        headers: { Cookie: "session=fixture", Accept: "text/html" },
      }),
      fetchResponse: async (request) => {
        expect(request.url).toBe("https://stella.test/law/cases?q=fixture");
        expect(request.method).toBe("GET");
        expect(request.headers.get("Cookie")).toBe("session=fixture");
        expect(request.headers.get("Accept")).toBe("text/html");
        return new Response(SHELL, {
          status: 201,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=300, s-maxage=600",
            "Content-Length": String(encoder.encode(SHELL).length),
          },
        });
      },
      reportError: (error) => {
        errors.push(error);
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.get("Content-Length")).toBe(
      contentType.startsWith("text/html")
        ? null
        : String(encoder.encode(SHELL).length),
    );
    expect(response.headers.get("Cache-Control")).toBe(
      contentType.startsWith("text/html")
        ? "private, no-store"
        : "public, max-age=300, s-maxage=600",
    );
    expect(await response.text()).toBe(SHELL);
    expect(errors).toEqual([]);
  }
});

test("SSR streams complete when a React component fails after its shell flushes", async () => {
  const ready = Promise.withResolvers<undefined>();
  const renderer = new AbortController();
  const renderErrors: unknown[] = [];
  const streamErrors: unknown[] = [];
  const failure = new TypeError("Deferred server component failed");
  let resumed = false;
  const DeferredFailure = () => {
    if (!resumed) {
      use(ready.promise);
    }
    throw failure;
  };
  const source = await renderToReadableStream(
    createElement(
      "html",
      null,
      createElement(
        "body",
        null,
        createElement("main", null, "Server shell"),
        createElement(
          Suspense,
          { fallback: createElement("p", null, "Deferred fallback") },
          createElement(DeferredFailure),
        ),
      ),
    ),
    {
      signal: renderer.signal,
      onError: (error) => {
        renderErrors.push(error);
      },
    },
  );
  const body = boundSsrStream({
    source,
    signal: renderer.signal,
    abortRenderer: (error) => renderer.abort(error),
    reportError: (error) => {
      streamErrors.push(error);
    },
  });
  const reader = body.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("Server shell");
  expect(renderErrors).toEqual([]);
  resumed = true;
  ready.resolve(undefined);
  let html = new TextDecoder().decode(first.value);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    html += new TextDecoder().decode(chunk.value);
  }
  expect(renderErrors).toEqual([failure]);
  expect(streamErrors).toEqual([]);
  expect(html).toContain("Deferred fallback");
  expect(html).toContain("</html>");
  expect(source.locked).toBe(false);
});

test("SSR streams preserve successful HTML and release their source", async () => {
  const errors: unknown[] = [];
  const html = `${SHELL}</body></html>`;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(SHELL));
      controller.enqueue(encoder.encode("</body></html>"));
      controller.close();
    },
  });
  const body = boundSsrStream({
    source,
    signal: new AbortController().signal,
    abortRenderer: () => {},
    reportError: (error) => {
      errors.push(error);
    },
  });
  expect(await new Response(body).text()).toBe(html);
  expect(errors).toEqual([]);
  expect(source.locked).toBe(false);
});

test("SSR responses error the body after a source fails during a pending read", async () => {
  const errors: unknown[] = [];
  const failure = new TypeError(
    "A previously unvisited boundary must have exactly one root segment",
  );
  let failSource = () => {};
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(SHELL));
      failSource = () => controller.error(failure);
    },
  });
  const response = await fetchBoundedSsrResponse({
    request: new Request("https://stella.test/law/cases"),
    fetchResponse: async () =>
      new Response(source, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=600",
        },
      }),
    reportError: (error) => {
      errors.push(error);
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const reader = response.body?.getReader();
  if (!reader) {
    throw new TypeError("SSR response body missing");
  }
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(SHELL);
  const pending = reader.read();
  failSource();
  expect(await rejectionOf(pending)).toBe(failure);
  // Let detached cancellation rejections settle before counting reports.
  await Bun.sleep(0);
  expect(errors).toEqual([failure]);
  expect(source.locked).toBe(false);
});

test("SSR drain timeout errors the body even when cancellation never settles", async () => {
  const errors: unknown[] = [];
  const renderer = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(SHELL));
    },
    async cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const body = boundSsrStream({
    source,
    signal: renderer.signal,
    lifetimeMs: 10,
    abortRenderer: (error) => renderer.abort(error),
    drainMs: 10,
    reportError: (error) => {
      errors.push(error);
    },
  });
  const reader = body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(SHELL);
  expect(await rejectionOf(reader.read())).toBeInstanceOf(
    SsrStreamTimeoutError,
  );
  expect(errors).toHaveLength(1);
  expect(errors.at(0)).toBeInstanceOf(SsrStreamTimeoutError);
  expect(renderer.signal.aborted).toBe(true);
  expect(renderer.signal.reason).toBe(errors.at(0));
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
});

test("SSR stream cancellation releases the renderer without awaiting its cancellation", async () => {
  const errors: unknown[] = [];
  const reason = "consumer stopped reading";
  let cancelledWith: unknown;
  const source = new ReadableStream<Uint8Array>({
    async cancel(value) {
      cancelledWith = value;
      return new Promise<void>(() => {});
    },
  });
  const body = boundSsrStream({
    source,
    signal: new AbortController().signal,
    abortRenderer: () => {},
    reportError: (error) => {
      errors.push(error);
    },
  });
  await body.cancel(reason);
  expect(cancelledWith).toBe(reason);
  expect(source.locked).toBe(false);
  expect(errors).toEqual([]);
});

test.each(["before reading", "during reading"])(
  "SSR request abort errors the response %s",
  async (phase) => {
    const abort = new AbortController();
    const reason = new DOMException("Request cancelled", "AbortError");
    const errors: unknown[] = [];
    let cancelledWith: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(value) {
        cancelledWith = value;
      },
    });
    if (phase === "before reading") {
      abort.abort(reason);
    }
    const body = boundSsrStream({
      source,
      signal: abort.signal,
      abortRenderer: () => {},
      reportError: (error) => {
        errors.push(error);
      },
    });
    const completion = new Response(body).text();
    if (phase === "during reading") {
      abort.abort(reason);
    }
    expect(await rejectionOf(completion)).toBe(reason);
    expect(cancelledWith).toBe(reason);
    expect(source.locked).toBe(false);
    expect(errors).toEqual([reason]);
  },
);
