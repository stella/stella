import { panic, Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { runWithPublicReadScope } from "@/api/lib/legal-search/public-read-timeout-context";
import { requireReconciliation } from "@/api/tests/helpers/case-law-adapter-test-utils";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { huBhgyAdapter } from "./hu-bhgy";
import { plSnAdapter } from "./pl-sn";
import { PUBLISHER_BODY_MAX_BYTES } from "./publisher-read";

type Publisher = "hu-bhgy" | "pl-sn";
const testFetch = createTestFetch();
beforeEach(() => {
  spyOn(Bun, "sleep").mockResolvedValue(undefined);
});
afterEach(() => {
  mock.restore();
});

const listSlice = async (publisher: Publisher, signal?: AbortSignal) => {
  switch (publisher) {
    case "hu-bhgy":
      return await requireReconciliation(huBhgyAdapter).listSlicePage({
        slice: "2000-b-gazd",
        page: 0,
        signal,
      });
    case "pl-sn":
      return await plSnAdapter.reconciliation.listSlicePage({
        slice: "2025-06-11",
        page: 0,
        signal,
      });
    default:
      publisher satisfies never;
      return panic("Unknown publisher");
  }
};

const emptyEnvelope = (publisher: Publisher) =>
  JSON.stringify(
    publisher === "hu-bhgy"
      ? { List: [], Count: 0, Success: true, Message: null }
      : { success: true, data: [{ success: true, data: [] }] },
  );

/** Valid JSON up to the stated length, without allocating the whitespace. */
const paddedEnvelope = (publisher: Publisher, byteLength: number) => {
  const prefix = new TextEncoder().encode(emptyEnvelope(publisher));
  const whitespace = new Uint8Array(64 * 1024).fill(32);
  let sentPrefix = false;
  let remaining = byteLength - prefix.byteLength;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sentPrefix) {
          sentPrefix = true;
          controller.enqueue(prefix);
        } else if (remaining > 0) {
          const length = Math.min(remaining, whitespace.byteLength);
          remaining -= length;
          controller.enqueue(whitespace.subarray(0, length));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, wasCancelled: () => cancelled };
};

for (const publisher of ["hu-bhgy", "pl-sn"] as const) {
  describe(`${publisher} publisher envelope reads`, () => {
    test.each(["exact", "oversized"] as const)(
      "%s listing body respects the publisher byte ceiling",
      async (size) => {
        const body = paddedEnvelope(
          publisher,
          PUBLISHER_BODY_MAX_BYTES + (size === "oversized" ? 1 : 0),
        );
        let requests = 0;
        testFetch.set(
          asFetchMock(async () => {
            requests += 1;
            return new Response(body.body);
          }),
        );
        if (size === "exact") {
          expect(await listSlice(publisher)).toEqual({
            items: [],
            totalPages: 0,
          });
          expect(body.wasCancelled()).toBe(false);
        } else {
          const error = await rejectionOf(listSlice(publisher));
          expect(error).toBeInstanceOf(AdapterFetchError);
          expect(error).toMatchObject({
            message: expect.stringContaining(String(PUBLISHER_BODY_MAX_BYTES)),
          });
          expect(body.wasCancelled()).toBe(true);
        }
        expect(requests).toBe(1);
      },
    );

    test.each(["", "not-json", '{"unexpected":true}'])(
      "invalid envelope %j cannot become an empty page",
      async (body) => {
        testFetch.set(asFetchMock(async () => new Response(body)));
        expect(await rejectionOf(listSlice(publisher))).toBeInstanceOf(
          AdapterFetchError,
        );
      },
    );

    test.each([
      new DOMException("Publisher stream failed", "NetworkError"),
      "publisher transport refused",
      { code: "STREAM_FAILED" },
    ])(
      "a broken body retains its error or normalized cause: %j",
      async (failure) => {
        testFetch.set(
          asFetchMock(
            async () =>
              new Response(
                new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      controller.error(failure);
                    },
                  },
                  { highWaterMark: 0 },
                ),
              ),
          ),
        );
        const error = await rejectionOf(listSlice(publisher));
        if (failure instanceof Error) {
          expect(error).toBe(failure);
        } else {
          expect(error).toBeInstanceOf(AdapterFetchError);
          expect(error).toMatchObject({
            adapterKey: publisher,
            cursor: publisher === "hu-bhgy" ? "2000-b-gazd" : "2025-06-11",
          });
          if (error instanceof AdapterFetchError) {
            expect(error.cause).toBe(failure);
          }
        }
      },
    );

    test("an HTTP refusal retains its status and slice cursor", async () => {
      testFetch.set(
        asFetchMock(async () => new Response("refused", { status: 403 })),
      );
      expect(await rejectionOf(listSlice(publisher))).toMatchObject({
        _tag: "AdapterFetchError",
        httpStatus: 403,
        cursor: publisher === "hu-bhgy" ? "2000-b-gazd" : "2025-06-11",
      });
    });

    test.each(["parent", "caller"] as const)(
      "%s cancellation settles a body that stopped after headers",
      async (owner) => {
        const controller = new AbortController();
        const started = Promise.withResolvers<undefined>();
        const failure = new DOMException(
          "Publisher read stopped",
          "AbortError",
        );
        let cancelled = false;
        testFetch.set(
          asFetchMock(
            async () =>
              new Response(
                new ReadableStream<Uint8Array>(
                  {
                    pull() {
                      started.resolve(undefined);
                    },
                    cancel() {
                      cancelled = true;
                    },
                  },
                  { highWaterMark: 0 },
                ),
              ),
          ),
        );
        const reading = runWithPublicReadScope(
          {
            budgetMs: 1000,
            signal: owner === "parent" ? controller.signal : undefined,
          },
          async () =>
            await listSlice(
              publisher,
              owner === "caller" ? controller.signal : undefined,
            ),
        );
        await started.promise;
        controller.abort(failure);
        const result = await reading;
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error).toBe(failure);
        }
        expect(cancelled).toBe(true);
      },
    );
  });
}
