import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  isReadRefusal,
  readOutcomeOfStatus,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import {
  PUBLISHER_BODY_MAX_BYTES,
  readBodyText,
  readGatedResponseText,
  readPublisher,
  readPublisherBytes,
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
  overrides: Partial<Omit<PublisherReadInit, "timeout" | "timeoutMs">> = {},
): PublisherReadInit => ({
  adapterKey: ADAPTER_KEYS.CZ_NSS,
  fetchStage: "listing",
  timeout: { type: "idle", ms: 1000 },
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
    expect(outcome.type === "present" ? outcome.value.status : null).toBe(200);
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
    for (const status of [500, 502, 503, 400, 408]) {
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

  test("a 429 halts the cycle as a typed publisher refusal after one request", async () => {
    let requests = 0;
    globalThis.fetch = asFetchMock(async () => {
      requests += 1;
      return await Promise.resolve(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      );
    });
    const rejection = await rejectionOf(
      readPublisherText(URL_UNDER_TEST, init()),
    );
    expect(rejection).toBeInstanceOf(AdapterFetchError);
    expect(
      rejection instanceof AdapterFetchError
        ? {
            stopKind: rejection.stopKind,
            httpStatus: rejection.httpStatus,
            retryAfter: rejection.retryAfter,
          }
        : null,
    ).toEqual({
      stopKind: INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
      httpStatus: 429,
      retryAfter: "120",
    });
    expect(requests).toBe(1);
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

  test("decodes UTF-8 as Response.text() does", async () => {
    const BYTE_ORDER_MARK = String.fromCodePoint(0xfe_ff);
    const served = `${BYTE_ORDER_MARK}rozhodnutí č. 1 § 2 \u{1F600}`;
    const bytes = new Uint8Array([...new TextEncoder().encode(served), 0xff]);
    serve(() => new Response(bytes, { status: 200 }));
    const outcome = await readPublisherText(URL_UNDER_TEST, init());
    expect(outcome).toEqual({
      type: "present",
      value: await new Response(bytes).text(),
    });
  });
});

const CHUNK_BYTES = 1024 * 1024;

/**
 * A served body that never ends, counting how many chunks the reader pulled.
 * One chunk is reused, so the stream itself holds no memory.
 */
const endlessBody = () => {
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x61);
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      state.pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return { body, state };
};

/** A body that serves one chunk after the headers, then resets. */
const resetBody = () =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("<p>partial"));
    },
    pull: (controller) => {
      controller.error(new TypeError("Connection reset by peer"));
    },
  });

describe.each([
  ["readPublisherText", readPublisherText],
  ["readPublisherBytes", readPublisherBytes],
] as const)("%s body bounds", (_name, read) => {
  test("a body over the ceiling is too-large, read no further than the ceiling", async () => {
    const { body, state } = endlessBody();
    serve(() => new Response(body, { status: 200 }));
    expect(await read(URL_UNDER_TEST, init())).toEqual({
      type: "unavailable",
      cause: { kind: "too-large", maxBytes: PUBLISHER_BODY_MAX_BYTES },
    });
    // The stream never ends, so returning at all proves the read stopped;
    // the pull count proves where.
    expect(state.pulled).toBeLessThanOrEqual(
      PUBLISHER_BODY_MAX_BYTES / CHUNK_BYTES + 2,
    );
  });

  test("a body that resets after the headers is a failure to read", async () => {
    serve(() => new Response(resetBody(), { status: 200 }));
    const outcome = await read(URL_UNDER_TEST, init());
    expect(outcome.type).toBe("unavailable");
    expect(outcome.type === "unavailable" ? outcome.cause.kind : null).toBe(
      "thrown",
    );
  });

  test("an empty 200 body is a failure to read", async () => {
    serve(() => new Response(new Uint8Array(0), { status: 200 }));
    expect(await read(URL_UNDER_TEST, init())).toEqual({
      type: "unavailable",
      cause: { kind: "empty-body", status: 200 },
    });
  });
});

describe("readBodyText", () => {
  test("reads an outcome whose headers the caller inspected first", async () => {
    serve(
      () =>
        new Response("body", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const outcome = await readPublisher(URL_UNDER_TEST, init());
    expect(
      outcome.type === "present"
        ? outcome.value.headers.get("Content-Type")
        : null,
    ).toBe("text/html");
    expect(await readBodyText(outcome, undefined)).toEqual({
      type: "present",
      value: "body",
    });
  });

  test("passes every other outcome through unread", async () => {
    const absent = { type: "absent", evidence: "http-410" } as const;
    expect(await readBodyText(absent, undefined)).toEqual(absent);
  });
});

describe("readPublisherBytes", () => {
  test("a served body is present as its exact bytes", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    serve(() => new Response(bytes, { status: 200 }));
    expect(await readPublisherBytes(URL_UNDER_TEST, init())).toEqual({
      type: "present",
      value: bytes,
    });
  });

  test("a status outcome is returned without reading a body", async () => {
    serve(() => new Response("missing", { status: 404 }));
    expect(await readPublisherBytes(URL_UNDER_TEST, init())).toEqual({
      type: "absent",
      evidence: "http-404",
    });
  });
});

test("no publisher status other than 404 and 410 reads as an absence, and only 401, 403 and 451 as a refusal", async () => {
  await assertProperty(
    "no publisher status other than 404 and 410 reads as an absence, and only 401, 403 and 451 as a refusal",
    fc.asyncProperty(
      fc.oneof(
        fc.integer({ min: 200, max: 599 }).filter((status) => status !== 429),
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

describe("gate refusal results", () => {
  for (const status of [401, 403, 451]) {
    for (const scope of ["document", "part", "source"] as const) {
      test(`HTTP ${status} thrown by a gate retains ${scope} scope`, async () => {
        const outcome = readOutcomeOfStatus(status, scope, "60");
        if (outcome.type !== "refused") {
          panic("Expected refusal fixture");
        }
        const error = unreadPublisherError({
          outcome,
          message: "Gate refused",
          adapterKey: ADAPTER_KEYS.CZ_US,
          cursor: null,
        });
        const request = async (): Promise<Response> => {
          throw error;
        };
        const options = { request, signal: undefined, refusalScope: scope };
        if (scope === "source") {
          expect(await rejectionOf(readGatedResponseText(options))).toBe(error);
        } else {
          expect(await readGatedResponseText(options)).toEqual(outcome);
          const controller = new AbortController();
          controller.abort();
          expect(
            await rejectionOf(
              readGatedResponseText({ ...options, signal: controller.signal }),
            ),
          ).toBe(error);
        }
      });
    }
  }
});
