import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createResponseSet } from "@/api/http/context";
import type { RequestContext } from "@/api/http/context";
import { readBody } from "@/api/http/input";
import {
  admitMultipartRequest,
  MULTIPART_REQUEST_MAX_BYTES,
  multipartAdmission,
} from "@/api/lib/rate-limit/multipart-admission";

const multipartContext = (request: Request, requestBodyMaxBytes: number) =>
  ({
    request,
    server: null,
    path: "/upload",
    route: "/upload",
    params: {},
    query: {},
    set: createResponseSet(),
    routeEntry: {
      method: "POST",
      path: "/upload",
      middleware: [],
      definition: {
        config: { requestBodyMaxBytes },
        access: "public",
        run: async () => null,
      },
    },
  }) satisfies RequestContext;

describe("admitMultipartRequest", () => {
  test("refuses a declared oversized multipart body before parsing", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: "not read",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(MULTIPART_REQUEST_MAX_BYTES + 1),
      },
    });

    const admitted = await admitMultipartRequest(request);

    expect(Result.isError(admitted)).toBe(true);
    expect(request.bodyUsed).toBe(false);
  });

  test("refuses an upper-case multipart media type the same way", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: "not read",
      headers: {
        "content-type": "Multipart/Form-Data; boundary=test",
        "content-length": String(MULTIPART_REQUEST_MAX_BYTES + 1),
      },
    });

    const admitted = await admitMultipartRequest(request);

    expect(Result.isError(admitted)).toBe(true);
  });

  test("leaves non-multipart request bodies unread", async () => {
    const request = new Request("http://localhost/raw", {
      method: "POST",
      body: "raw body",
      headers: { "content-type": "application/json" },
    });

    const admitted = await admitMultipartRequest(request);

    expect(Result.isOk(admitted) && admitted.value).toBe(request);
    expect(request.bodyUsed).toBe(false);
  });

  test("a route maximum cannot raise the global multipart ceiling", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: "unread",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(MULTIPART_REQUEST_MAX_BYTES + 1),
      },
    });
    const admitted = await admitMultipartRequest(
      request,
      MULTIPART_REQUEST_MAX_BYTES * 2,
    );
    expect(Result.isError(admitted)).toBe(true);
    expect(request.bodyUsed).toBe(false);
  });

  test.each([Number.NaN, Infinity, -1, 1.5])(
    "rejects an invalid configured multipart maximum %p before reading",
    async (maximum) => {
      const request = new Request("http://localhost/upload", {
        method: "POST",
        body: "unread",
        headers: { "content-type": "multipart/form-data; boundary=test" },
      });
      expect(
        await rejectionOf(admitMultipartRequest(request, maximum)),
      ).toMatchObject({
        message:
          "Multipart request byte limit must be a nonnegative safe integer",
      });
      expect(request.bodyUsed).toBe(false);
    },
  );
});

describe("multipart admission route limits", () => {
  test("refuses a declared route oversize before pulling the body or parsing", async () => {
    let pulls = 0;
    let parsed = false;
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": "4",
      },
      body: new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            pulls += 1;
            controller.enqueue(new Uint8Array([1]));
          },
        },
        { highWaterMark: 0 },
      ),
    });
    const response = await multipartAdmission(
      multipartContext(request, 3),
      async () => {
        parsed = true;
        await readBody(request, "auto");
        return new Response(null, { status: 204 });
      },
    );
    expect(response.status).toBe(413);
    expect(pulls).toBe(0);
    expect(request.bodyUsed).toBe(false);
    expect(parsed).toBe(false);
  });

  test.each([undefined, "0", "1"])(
    "cancels at the crossing chunk before parsing with declared length %p",
    async (declaredLength) => {
      let pulls = 0;
      let cancelled = false;
      let parsed = false;
      const headers = new Headers({
        "content-type": "multipart/form-data; boundary=test",
      });
      if (declaredLength !== undefined) {
        headers.set("content-length", declaredLength);
      }
      const request = new Request("http://localhost/upload", {
        method: "POST",
        headers,
        body: new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              pulls += 1;
              controller.enqueue(new Uint8Array([1, 2]));
            },
            cancel: () => {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      });
      const response = await multipartAdmission(
        multipartContext(request, 3),
        async () => {
          parsed = true;
          await readBody(request, "auto");
          return new Response(null, { status: 204 });
        },
      );
      expect(response.status).toBe(413);
      expect(pulls).toBe(2);
      expect(cancelled).toBe(true);
      expect(parsed).toBe(false);
      await Promise.resolve();
      expect(pulls).toBe(2);
    },
  );

  test("a multipart body exactly at its route maximum reaches the parser intact", async () => {
    const form = new FormData();
    form.set("name", "Žaneta Hrubá");
    const original = new Request("http://localhost/upload", {
      method: "POST",
      body: form,
    });
    const headers = new Headers(original.headers);
    const bytes = await original.arrayBuffer();
    const request = new Request(original.url, {
      method: "POST",
      headers,
      body: bytes,
    });
    const ctx = multipartContext(request, bytes.byteLength);
    const response = await multipartAdmission(ctx, async (replacement) => {
      const admitted = replacement ?? ctx;
      const parsed = await readBody(admitted.request, "auto");
      return Response.json(parsed);
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "Žaneta Hrubá" });
  });
});
