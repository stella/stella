import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { isReadRefusal } from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import {
  readPublisher,
  readPublisherText,
  unreadPublisherError,
  type PublisherReadInit,
} from "./publisher-read";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const URL_UNDER_TEST = "https://publisher.invalid/document/1";

const init = (
  overrides: Partial<PublisherReadInit> = {},
): PublisherReadInit => ({
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

  test("401, 403 and 451 are typed refusals, never absences or failures", async () => {
    for (const status of [401, 403, 451] as const) {
      serve(() => new Response("refused", { status }));
      const outcome = await readPublisher(URL_UNDER_TEST, init());
      expect(outcome).toEqual({
        type: "refused",
        status,
        scope: "document",
        cause: { kind: "http-status", retryAfter: null },
      });
      expect(isReadRefusal(outcome)).toBe(true);
    }
  });

  test("a refusal names the scope the caller read and the Retry-After it carried", async () => {
    serve(
      () =>
        new Response("refused", {
          status: 403,
          headers: { "Retry-After": "3600" },
        }),
    );
    expect(
      await readPublisherText(URL_UNDER_TEST, init({ refusalScope: "part" })),
    ).toEqual({
      type: "refused",
      status: 403,
      scope: "part",
      cause: { kind: "http-status", retryAfter: "3600" },
    });
  });

  test("a 5xx, a 204 and other 4xx answers are failures to read", async () => {
    for (const status of [500, 502, 503, 400, 408, 429]) {
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

  test("a source-level refusal stop still ends the cycle by throwing", async () => {
    for (const status of [401, 403, 429]) {
      serve(() => new Response("refused", { status }));
      const rejection = await rejectionOf(
        readPublisher(URL_UNDER_TEST, init({ refusalMode: "stop-refusal" })),
      );
      expect(rejection).toBeInstanceOf(AdapterFetchError);
    }
  });
});

test("only a refusal with a refusal status and a scope is a refusal marker", () => {
  const refusal = {
    type: "refused",
    status: 403,
    scope: "part",
    cause: { kind: "http-status", retryAfter: null },
  };
  expect(isReadRefusal(refusal)).toBe(true);
  for (const value of [
    { ...refusal, status: 404 },
    { ...refusal, status: 500 },
    { ...refusal, scope: "page" },
    { type: "absent", evidence: "http-404" },
    { type: "unavailable", cause: { kind: "status", status: 403 } },
    null,
    "refused",
  ]) {
    expect(isReadRefusal(value)).toBe(false);
  }
});

describe("unreadPublisherError", () => {
  test.each([
    { scope: "document", stopKind: "adapter_error" },
    { scope: "part", stopKind: "adapter_error" },
    { scope: "source", stopKind: "publisher_refusal" },
  ] as const)(
    "a $scope refusal carries its typed marker and stops as $stopKind",
    async ({ scope, stopKind }) => {
      globalThis.fetch = asFetchMock(
        async () =>
          await Promise.resolve(
            new Response("", { status: 403, headers: { "Retry-After": "60" } }),
          ),
      );
      const outcome = await readPublisher(
        URL_UNDER_TEST,
        init({ refusalScope: scope }),
      );
      if (outcome.type !== "refused") {
        panic(`expected a refusal, got ${outcome.type}`);
      }

      const error = unreadPublisherError({
        outcome,
        message: "refused",
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: null,
      });

      expect(isReadRefusal(error.cause)).toBe(true);
      expect(error).toMatchObject({
        httpStatus: 403,
        retryAfter: "60",
        stopKind,
      });
    },
  );
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

test("no publisher status other than 404 and 410 reads as an absence, and only 401, 403 and 451 as a refusal", async () => {
  await assertProperty(
    "no publisher status other than 404 and 410 reads as an absence, and only 401, 403 and 451 as a refusal",
    fc.asyncProperty(
      fc.oneof(
        fc.integer({ min: 200, max: 599 }),
        fc.constantFrom(204, 401, 403, 404, 410, 451),
      ),
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
          case "refused":
            expect([401, 403, 451]).toContain(status);
            expect<number>(outcome.status).toBe(status);
            expect(outcome.scope).toBe("document");
            return;
          case "unavailable":
            expect([404, 410, 401, 403, 451]).not.toContain(status);
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
