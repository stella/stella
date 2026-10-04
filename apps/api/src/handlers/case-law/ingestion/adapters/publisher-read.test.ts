import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { readPublisher, readPublisherText } from "./publisher-read";
import type { PublisherFetchInit } from "./retry";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const URL_UNDER_TEST = "https://publisher.invalid/document/1";

const init = (
  overrides: Partial<PublisherFetchInit> = {},
): PublisherFetchInit => ({
  adapterKey: ADAPTER_KEYS.CZ_NSS,
  fetchStage: "listing",
  timeoutMs: 1000,
  ...overrides,
});

const serve = (response: () => Response | Promise<Response>) => {
  globalThis.fetch = asFetchMock(async () => await response());
};

const nullBodyStatus = (status: number) =>
  status === 204 || status === 205 || status === 304;

describe("readPublisher", () => {
  test("a 2xx answer with content is present", async () => {
    serve(() => new Response("<p>text</p>", { status: 200 }));
    const outcome = await readPublisher(URL_UNDER_TEST, init());
    expect(outcome.type).toBe("present");
    expect(outcome.type === "present" ? await outcome.value.text() : null).toBe(
      "<p>text</p>",
    );
  });

  test("only 404 and 410 state an absence", async () => {
    for (const [status, evidence] of [
      [404, "http-404"],
      [410, "http-410"],
    ] as const) {
      serve(() => new Response("gone", { status }));
      expect(await readPublisher(URL_UNDER_TEST, init())).toEqual({
        type: "absent",
        evidence,
      });
    }
  });

  test("a 5xx, a 204 and other 4xx answers are failures to read", async () => {
    for (const status of [500, 502, 503, 400, 403, 429]) {
      serve(() => new Response("error", { status }));
      expect(await readPublisher(URL_UNDER_TEST, init())).toEqual({
        type: "unavailable",
        cause: { kind: "status", status },
      });
    }
    serve(() => new Response(null, { status: 204 }));
    expect(await readPublisher(URL_UNDER_TEST, init())).toEqual({
      type: "unavailable",
      cause: { kind: "no-content", status: 204 },
    });
  });

  test("a thrown request (timeout, network) is a failure to read", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    globalThis.fetch = asFetchMock(async () => await Promise.reject(timeout));
    const outcome = await readPublisher(URL_UNDER_TEST, init());
    expect(outcome.type).toBe("unavailable");
    expect(outcome.type === "unavailable" ? outcome.cause.kind : null).toBe(
      "thrown",
    );
  });

  test("the caller's cancellation still ends the read by throwing", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    globalThis.fetch = asFetchMock(
      async () =>
        await Promise.reject(new DOMException("cancelled", "AbortError")),
    );
    const rejection = await rejectionOf(
      readPublisher(URL_UNDER_TEST, init({ signal: controller.signal })),
    );
    expect(rejection).toBeInstanceOf(DOMException);
  });

  test("a publisher refusal stop still ends the cycle by throwing", async () => {
    serve(() => new Response("slow down", { status: 429 }));
    const rejection = await rejectionOf(
      readPublisher(URL_UNDER_TEST, init({ refusalMode: "stop-refusal" })),
    );
    expect(rejection).toBeInstanceOf(AdapterFetchError);
  });
});

describe("readPublisherText", () => {
  test("an empty 200 body is a failure to read, not an empty document", async () => {
    serve(() => new Response("", { status: 200 }));
    expect(await readPublisherText(URL_UNDER_TEST, init())).toEqual({
      type: "unavailable",
      cause: { kind: "empty-body", status: 200 },
    });
  });

  test("a served body is present as text", async () => {
    serve(() => new Response("body", { status: 200 }));
    expect(await readPublisherText(URL_UNDER_TEST, init())).toEqual({
      type: "present",
      value: "body",
    });
  });
});

test("no publisher status other than 404 and 410 reads as an absence", async () => {
  await assertProperty(
    "no publisher status other than 404 and 410 reads as an absence",
    fc.asyncProperty(
      fc.integer({ min: 200, max: 599 }),
      fc.string({ maxLength: 8 }),
      async (status, body) => {
        serve(
          () => new Response(nullBodyStatus(status) ? null : body, { status }),
        );
        const outcome = await readPublisherText(URL_UNDER_TEST, init());
        switch (outcome.type) {
          case "absent":
            expect([404, 410]).toContain(status);
            return;
          case "present":
            expect(status).toBeGreaterThanOrEqual(200);
            expect(status).toBeLessThan(300);
            expect(status).not.toBe(204);
            expect(outcome.value).toBe(body);
            expect(outcome.value.length).toBeGreaterThan(0);
            return;
          case "unavailable":
            expect([404, 410]).not.toContain(status);
            return;
          default:
            outcome satisfies never;
            panic(`Unhandled read outcome: ${String(outcome)}`);
        }
      },
    ),
    { numRuns: 200 },
  );
});
