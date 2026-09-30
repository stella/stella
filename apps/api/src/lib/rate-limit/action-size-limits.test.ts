import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

import {
  ActionSizeError,
  actionSizeErrorResponse,
  boundActionJsonResponse,
  boundActionRequest,
  getActionSizePolicy,
  getTenantActionSizePolicy,
  normalizeTenantPageLimit,
  withTenantActionSizePolicy,
} from "./action-size-limits";

const policy = { requestBytes: 512, responseBytes: 512, pageSize: 3 };
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

describe("tenant action size boundaries", () => {
  test("meters actual UTF-8 request bytes at the exact bound even when the declared length lies", async () => {
    for (const body of ["é", "😀", '"\\n\\\""', "plain"]) {
      const size = utf8.encode(body).byteLength;
      for (const declaredLength of [undefined, "0", "1", String(size)]) {
        const bounded = await boundActionRequest(
          requestWithBody(body, declaredLength),
          size,
        );
        if (Result.isError(bounded)) {
          throw bounded.error;
        }
        expect(await bounded.value.text()).toBe(body);
        expect(bounded.value.headers.get("content-length")).toBe(String(size));
        expect(bounded.value.headers.get("x-request-id")).toBe("request-size");
        const refused = await boundActionRequest(
          requestWithBody(body, declaredLength),
          size - 1,
        );
        expect(Result.isError(refused)).toBe(true);
        if (Result.isError(refused)) {
          expect(refused.error.reason).toBe("request_too_large");
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
    expect(Result.isError(await boundActionRequest(declaredOversize, 3))).toBe(
      true,
    );
    expect(pulls).toBe(0);
    const chunked = new Request("http://localhost/v1/action", {
      body: source(),
      headers: { "content-length": "1" },
      method: "POST",
    });
    expect(Result.isError(await boundActionRequest(chunked, 3))).toBe(true);
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
    for (const declaredLength of ["-1", "1.5", "NaN", "not-a-length"]) {
      expect(
        Result.isError(
          await boundActionRequest(requestWithBody("{}", declaredLength), 10),
        ),
      ).toBe(true);
    }
  });

  test("bounds complete serialized JSON envelopes including escaping and multibyte text without emitting fragments", async () => {
    for (const text of ["é", "😀", 'line\nquote"slash\\', "\u0000", "plain"]) {
      const serialized = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text }],
          structuredContent: { text },
        },
      });
      const size = utf8.encode(serialized).byteLength;
      const headers = new Headers({
        "content-type": "application/json; charset=utf-8",
        "content-length": String(size),
        etag: '"body-etag"',
        "content-disposition": "inline",
        "content-encoding": "identity",
        "access-control-allow-origin": "*",
        "x-request-id": "response-size",
      });
      const exact = await boundActionJsonResponse(
        new Response(serialized, {
          headers,
          status: 201,
          statusText: "Created",
        }),
        size,
      );
      expect(exact.status).toBe(201);
      expect(exact.statusText).toBe("Created");
      expect([...exact.headers]).toEqual([...headers]);
      expect(await exact.text()).toBe(serialized);
      const refused = await boundActionJsonResponse(
        new Response(serialized, { headers }),
        size - 1,
      );
      expect(refused.status).toBe(413);
      expect(refused.headers.get("etag")).toBeNull();
      expect(refused.headers.get("content-length")).toBeNull();
      expect(refused.headers.get("content-disposition")).toBeNull();
      expect(refused.headers.get("content-encoding")).toBeNull();
      expect(refused.headers.get("x-request-id")).toBe("response-size");
      expect(refused.headers.get("access-control-allow-origin")).toBe("*");
      const emitted = await refused.text();
      expect(utf8.encode(emitted).byteLength).toBeLessThanOrEqual(size - 1);
      if (emitted !== "") {
        const envelope: unknown = JSON.parse(emitted);
        expect(envelope).toMatchObject({ code: "response_too_large" });
        expect(envelope).not.toHaveProperty("result");
      }
    }
  });

  test("does not read SSE or other non-JSON bodies and communicates tiny-bound refusals by status alone", async () => {
    for (const contentType of [
      "text/event-stream",
      "application/octet-stream",
      "text/plain",
    ]) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            pulls += 1;
            controller.enqueue(utf8.encode("stream"));
          },
        },
        { highWaterMark: 0 },
      );
      const original = new Response(body, {
        headers: { "content-type": contentType },
      });
      expect(await boundActionJsonResponse(original, 1)).toBe(original);
      expect(pulls).toBe(0);
      await body.cancel();
    }
    const refused = await boundActionJsonResponse(
      Response.json({ text: "oversized" }),
      1,
    );
    expect(refused.status).toBe(413);
    expect((await refused.arrayBuffer()).byteLength).toBe(0);
    expect(
      actionSizeErrorResponse(
        new ActionSizeError({
          message: "Missing limits",
          reason: "configuration",
        }),
      ).status,
    ).toBe(503);
    expect(
      (
        await actionSizeErrorResponse(
          new ActionSizeError({
            message: "Over limit",
            reason: "request_too_large",
          }),
          0,
        ).arrayBuffer()
      ).byteLength,
    ).toBe(0);
  });

  test("applies normalized defaults and explicit ceilings before fetching the sentinel so cursor walks never skip or repeat rows", () => {
    const allRows = Array.from({ length: 23 }, (_, index) => index);
    for (const pageSize of [1, 2, 3, 7]) {
      for (const requested of [undefined, 1, 2, 5, 10, 50]) {
        withTenantActionSizePolicy({ ...policy, pageSize }, () => {
          const seen: number[] = [];
          let cursor: string | null = null;
          do {
            const decoded =
              cursor === null ? -1 : decodePaginationCursor(cursor)?.at(0);
            if (typeof decoded !== "number") {
              panic("The issued test cursor must decode to a row position");
            }
            const limit = normalizeTenantPageLimit(requested ?? 5);
            const rows = allRows.slice(decoded + 1, decoded + 1 + limit + 1);
            const page = createCursorPage({
              rows,
              limit,
              cursorForItem: (item) => encodePaginationCursor([item]),
            });
            expect(page.limit).toBe(Math.min(requested ?? 5, pageSize));
            expect(page.items.length).toBeLessThanOrEqual(pageSize);
            if (page.nextCursor !== null) {
              expect(page.nextCursor).toBe(
                encodePaginationCursor([
                  page.items.at(-1) ??
                    panic("A nonterminal page must contain rows"),
                ]),
              );
              expect(page.nextCursor).not.toBe(cursor);
            }
            seen.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor !== null);
          expect(seen).toEqual(allRows);
          expect(new Set(seen).size).toBe(allRows.length);
        });
      }
    }
  });

  test("keeps concurrent tenant ceilings separate and leaves concurrent and later public work unchanged", async () => {
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const first = withTenantActionSizePolicy(
      { ...policy, pageSize: 2 },
      async () => {
        expect(normalizeTenantPageLimit(50)).toBe(2);
        entered.resolve(undefined);
        await resume.promise;
        expect(normalizeTenantPageLimit(50)).toBe(2);
      },
    );
    await entered.promise;
    expect(getTenantActionSizePolicy()).toBeUndefined();
    expect(normalizeTenantPageLimit(50)).toBe(50);
    await withTenantActionSizePolicy({ ...policy, pageSize: 7 }, async () => {
      await Promise.resolve();
      expect(normalizeTenantPageLimit(50)).toBe(7);
    });
    expect(
      withTenantActionSizePolicy(undefined, () => normalizeTenantPageLimit(50)),
    ).toBe(50);
    resume.resolve(undefined);
    await first;
    expect(getTenantActionSizePolicy()).toBeUndefined();
    expect(normalizeTenantPageLimit(50)).toBe(50);
  });
});

describe("operator action size configuration", () => {
  test("disabled policy does not read any operator limits", () => {
    const configured = getActionSizePolicy({
      FEATURE_ACTION_ADMISSION: false,
      get ACTION_REQUEST_MAX_BYTES() {
        return panic("Disabled policy read request limit");
      },
      get ACTION_RESPONSE_MAX_BYTES() {
        return panic("Disabled policy read response limit");
      },
      get ACTION_PAGE_SIZE_MAX() {
        return panic("Disabled policy read page limit");
      },
    });
    expect(Result.isOk(configured) && configured.value).toBeUndefined();
  });
  test("enabled policy fails closed unless all limits are configured", () => {
    const configured = {
      FEATURE_ACTION_ADMISSION: true,
      ACTION_REQUEST_MAX_BYTES: policy.requestBytes,
      ACTION_RESPONSE_MAX_BYTES: policy.responseBytes,
      ACTION_PAGE_SIZE_MAX: policy.pageSize,
    };
    expect(getActionSizePolicy(configured)).toEqual(Result.ok(policy));
    for (const name of [
      "ACTION_REQUEST_MAX_BYTES",
      "ACTION_RESPONSE_MAX_BYTES",
      "ACTION_PAGE_SIZE_MAX",
    ] as const) {
      const incomplete = getActionSizePolicy({
        ...configured,
        [name]: undefined,
      });
      expect(Result.isError(incomplete) && incomplete.error.reason).toBe(
        "configuration",
      );
    }
  });
});
