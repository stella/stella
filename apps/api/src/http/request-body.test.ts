import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { sendServedRequest } from "@/api/tests/helpers/served-request";

import {
  reframeBoundedRequest,
  RequestBodyTooLargeError,
} from "./request-body";

const utf8 = new TextEncoder();

const requestWithBody = (body: string, declaredLength?: string) => {
  const headers = new Headers({
    "content-type": "application/json",
    "x-request-id": "request-size",
  });
  if (declaredLength !== undefined) {
    headers.set("content-length", declaredLength);
  }
  return new Request("http://localhost/v1/action", {
    body,
    headers,
    method: "POST",
  });
};

describe("bounded request bodies", () => {
  test("meters actual UTF-8 request bytes at the exact bound even when the declared length lies", async () => {
    for (const body of ["é", "😀", '"\\n\\\""', "plain"]) {
      const size = utf8.encode(body).byteLength;
      for (const declaredLength of [undefined, "0", "1", String(size)]) {
        const original = requestWithBody(body, declaredLength);
        const bounded = await reframeBoundedRequest(original, size);
        if (Result.isError(bounded)) {
          throw bounded.error;
        }
        // A new request framed from exactly the metered bytes.
        const reframed = bounded.value.request;
        expect(reframed).not.toBe(original);
        expect(bounded.value.bytes).toBe(size);
        expect(reframed.url).toBe(original.url);
        expect(reframed.method).toBe("POST");
        expect(new Uint8Array(await reframed.arrayBuffer())).toEqual(
          utf8.encode(body),
        );
        expect(reframed.headers.get("content-length")).toBe(String(size));
        expect(reframed.headers.get("content-type")).toBe("application/json");
        expect(reframed.headers.get("x-request-id")).toBe("request-size");
        const refused = await reframeBoundedRequest(
          requestWithBody(body, declaredLength),
          size - 1,
        );
        expect(Result.isError(refused)).toBe(true);
        if (Result.isError(refused)) {
          expect(RequestBodyTooLargeError.is(refused.error)).toBe(true);
          expect(refused.error.maximum).toBe(size - 1);
        }
      }
    }
  });

  test("refuses a declared oversize without reading and cancels actual oversized producers at the crossing chunk", async () => {
    let pulls = 0;
    let cancelled = false;
    const source = () =>
      new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            pulls += 1;
            controller.enqueue(utf8.encode("é"));
          },
          cancel: () => {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
    const declaredOversize = new Request("http://localhost/v1/action", {
      body: source(),
      headers: { "content-length": "4" },
      method: "POST",
    });
    expect(
      Result.isError(await reframeBoundedRequest(declaredOversize, 3)),
    ).toBe(true);
    expect(pulls).toBe(0);
    const chunked = new Request("http://localhost/v1/action", {
      body: source(),
      headers: { "content-length": "1" },
      method: "POST",
    });
    expect(Result.isError(await reframeBoundedRequest(chunked, 3))).toBe(true);
    // Read once with no tee: the chunk that crosses the bound is the last pull.
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
    const pullsAtCancellation = pulls;
    await Promise.resolve();
    expect(pulls).toBe(pullsAtCancellation);
    for (const declaredLength of ["-1", "1.5", "NaN", "not-a-length"]) {
      expect(
        Result.isError(
          await reframeBoundedRequest(
            requestWithBody("{}", declaredLength),
            10,
          ),
        ),
      ).toBe(true);
    }
  });

  test("re-framed bodies stream under Bun.serve routes when the body arrived with its headers", async () => {
    const body = JSON.stringify({ text: "Příloha § 🗂", id: 1 });
    const bytes = utf8.encode(body).byteLength;
    const app = createHttpApp({
      middleware: [
        async (_ctx, inner) => {
          // real-time: the awaited pipeline stages run before the body is
          // touched, and only a real I/O gap lets the body sent with the
          // headers arrive in full first, the state under test.
          await Bun.sleep(5);
          return await inner();
        },
      ],
      routes: routes({
        "/v1/action": {
          POST: {
            access: "public",
            config: {},
            run: async ({ ctx }) => {
              const bounded = await reframeBoundedRequest(ctx.request, 1024);
              if (Result.isError(bounded)) {
                return new Response(bounded.error.message, { status: 413 });
              }
              const reframed = bounded.value.request;
              const stream: ReadableStream<Uint8Array> | null = reframed.body;
              if (stream === null) {
                return panic("The re-framed request lost its body");
              }
              const chunks: Uint8Array[] = [];
              for await (const chunk of stream) {
                chunks.push(chunk);
              }
              return {
                body: Buffer.concat(chunks).toString("utf-8"),
                contentLength: reframed.headers.get("content-length"),
                transferEncoding: reframed.headers.get("transfer-encoding"),
              };
            },
          },
        },
      }),
    });
    for (const framing of ["content-length", "chunked"] as const) {
      const response = await sendServedRequest(app, {
        path: "/v1/action",
        headers: { "Content-Type": "application/json" },
        body,
        framing,
      });
      expect({
        framing,
        status: response.status,
        answer: JSON.parse(response.body),
      }).toEqual({
        framing,
        status: 200,
        answer: { body, contentLength: String(bytes), transferEncoding: null },
      });
    }
  });
});
