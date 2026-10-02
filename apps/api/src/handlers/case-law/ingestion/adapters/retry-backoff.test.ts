import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { FetchBoundaryError } from "@stll/errors";
import { propertyConfig } from "@stll/property-testing";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import {
  PublisherRateLimitRefusalError,
  publisherRetryDelay,
  retryPublisherRequest,
} from "./retry";

const NOW = new Date("2026-10-02T00:00:00Z").getTime();
const URL = "https://publications.europa.eu/test";
const INIT = { adapterKey: ADAPTER_KEYS.EU_ECJ, timeoutMs: 1000 };

describe("publisher throttling and transient failures", () => {
  test("nested fetch-boundary connection failures retain their kind through adapter wrappers", async () => {
    for (const message of ["TLS handshake failed", "Unable to connect"]) {
      let requests = 0;
      const pending = retryPublisherRequest(URL, INIT, {
        request: async () => {
          requests++;
          throw new FetchBoundaryError({
            message,
            url: URL,
            failureKind: "source_unreachable",
          });
        },
        defer: async () => NOW,
        sleep: async () => undefined,
        now: () => NOW,
        random: () => 0.5,
      });
      const cause = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      const wrapped = new AdapterFetchError({
        message: "Page failed",
        adapterKey: INIT.adapterKey,
        cursor: null,
        cause,
      });
      expect(wrapped.stopKind).toBe("source_unreachable");
      expect(requests).toBe(1);
    }
  });

  for (const httpStatus of [401, 403, 429]) {
    test(`${httpStatus} is a publisher refusal even through a cause wrapper`, () => {
      const cause = new AdapterFetchError({
        message: "Refused",
        adapterKey: INIT.adapterKey,
        cursor: null,
        httpStatus,
      });
      expect(
        new AdapterFetchError({
          message: "Page failed",
          adapterKey: INIT.adapterKey,
          cursor: null,
          cause,
        }).stopKind,
      ).toBe("publisher_refusal");
    });
  }

  test("parse and invalid request failures are adapter errors", () => {
    for (const cause of [
      new SyntaxError("Invalid listing"),
      new TypeError("Invalid URL"),
    ]) {
      expect(
        new AdapterFetchError({
          message: "Page failed",
          adapterKey: INIT.adapterKey,
          cursor: null,
          cause,
        }).stopKind,
      ).toBe("adapter_error");
    }
  });
  const headers = [
    { label: "absent", value: null, wait: 1000 },
    { label: "seconds", value: "3", wait: 3000 },
    {
      label: "future date",
      value: new Date(NOW + 6000).toUTCString(),
      wait: 6000,
    },
    {
      label: "past date",
      value: new Date(NOW - 6000).toUTCString(),
      wait: 1000,
    },
    { label: "garbage", value: "later please", wait: 1000 },
    { label: "huge seconds", value: "999999999999999999999", wait: 900_000 },
    {
      label: "distant date",
      value: new Date(NOW + 3_600_000).toUTCString(),
      wait: 900_000,
    },
  ];
  for (const status of [408, 502, 503, 504]) {
    for (const header of headers) {
      test(`${status} respects Retry-After ${header.label} before recovering`, async () => {
        let requests = 0;
        const waits: number[] = [];
        const gateWaits: number[] = [];
        const response = await retryPublisherRequest(URL, INIT, {
          request: async () => {
            requests += 1;
            return requests === 1
              ? new Response(null, {
                  status,
                  headers:
                    header.value === null
                      ? {}
                      : { "Retry-After": header.value },
                })
              : new Response("recovered");
          },
          defer: async (durationMs) => {
            gateWaits.push(durationMs);
            return NOW + durationMs;
          },
          sleep: async (durationMs) => {
            waits.push(durationMs);
          },
          now: () => NOW,
          random: () => 0.5,
        });
        expect(await response.text()).toBe("recovered");
        expect(requests).toBe(2);
        expect(waits).toEqual([header.wait]);
        expect(gateWaits).toEqual(waits);
      });
    }
  }

  for (const status of [429, 302]) {
    for (const header of headers) {
      test(`${status} publishes Retry-After ${header.label} and stops after one typed refusal`, async () => {
        let requests = 0;
        const gateWaits: number[] = [];
        const waits: number[] = [];
        const pending = retryPublisherRequest(
          URL,
          {
            ...INIT,
            redirect: "manual",
            isRateLimitRedirect: (response) =>
              response.status === 302 &&
              response.headers.get("Location") === "/limit-exceeded.html",
          },
          {
            request: async () => {
              requests += 1;
              return new Response(null, {
                status,
                headers: {
                  Location: "/limit-exceeded.html",
                  ...(header.value === null
                    ? {}
                    : { "Retry-After": header.value }),
                },
              });
            },
            defer: async (durationMs) => {
              gateWaits.push(durationMs);
              return NOW + durationMs;
            },
            sleep: async (durationMs) => {
              waits.push(durationMs);
            },
            now: () => NOW,
            random: () => 0.5,
          },
        );
        expect(
          await pending.then(
            () => "accepted",
            (error: unknown) => error,
          ),
        ).toBeInstanceOf(PublisherRateLimitRefusalError);
        expect(
          await pending.then(
            () => "accepted",
            (error: unknown) => error,
          ),
        ).toMatchObject({
          publisherKey: "cellar-eu",
          status,
          stopKind: "publisher_refusal",
          cooldownUntilEpochMs: NOW + header.wait,
        });
        expect(requests).toBe(1);
        expect(gateWaits).toEqual([header.wait]);
        expect(waits).toEqual([]);
      });
    }
  }

  test("fractional jitter publishes and sleeps the same integer milliseconds", async () => {
    const deferred: number[] = [];
    const slept: number[] = [];
    let requests = 0;
    await retryPublisherRequest(URL, INIT, {
      request: async () =>
        new Response(null, { status: ++requests === 1 ? 503 : 200 }),
      defer: async (ms) => {
        deferred.push(ms);
        return NOW + ms;
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
      now: () => NOW,
      random: () => 0.370123,
    });
    expect(deferred).toEqual([741]);
    expect(slept).toEqual(deferred);
  });

  test("repeated transient failures succeed with five exponential waits", async () => {
    let requests = 0;
    const waits: number[] = [];
    const response = await retryPublisherRequest(URL, INIT, {
      request: async () =>
        new Response(null, { status: ++requests <= 5 ? 503 : 200 }),
      defer: async () => NOW,
      sleep: async (durationMs) => {
        waits.push(durationMs);
      },
      now: () => NOW,
      random: () => 0.5,
    });
    expect(response.status).toBe(200);
    expect(requests).toBe(6);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  test("exhausted failures propagate the typed retryable contract after exactly six requests", async () => {
    let requests = 0;
    const waits: number[] = [];
    const pending = retryPublisherRequest(URL, INIT, {
      request: async () => {
        requests += 1;
        return new Response(null, { status: 503 });
      },
      defer: async () => NOW,
      sleep: async (durationMs) => {
        waits.push(durationMs);
      },
      now: () => NOW,
      random: () => 0.5,
    });
    expect(
      await pending.then(
        () => "accepted",
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(AdapterFetchError);
    expect(requests).toBe(6);
    expect(waits).toHaveLength(5);
  });

  for (const status of [
    400, 401, 403, 404, 406, 409, 410, 415, 422, 500, 501, 505,
  ]) {
    test(`${status} is returned without spending a retry`, async () => {
      let requests = 0;
      const waits: number[] = [];
      const response = await retryPublisherRequest(
        URL,
        { ...INIT, refusalMode: "return-response" },
        {
          request: async () => {
            requests += 1;
            return new Response(null, {
              status,
              headers: { "Retry-After": "30" },
            });
          },
          defer: async (durationMs) => {
            waits.push(durationMs);
            return NOW + durationMs;
          },
          sleep: async (durationMs) => {
            waits.push(durationMs);
          },
          now: () => NOW,
          random: () => 0.5,
        },
      );
      expect(response.status).toBe(status);
      expect(requests).toBe(1);
      expect(waits).toEqual([]);
    });
  }

  for (const timeout of [
    new DOMException("Request timed out", "TimeoutError"),
    Object.assign(new Error("Socket timed out"), { code: "ETIMEDOUT" }),
  ]) {
    test(`${timeout.name} request timeout recovers with backoff`, async () => {
      let requests = 0;
      const waits: number[] = [];
      const response = await retryPublisherRequest(URL, INIT, {
        request: async () => {
          if (++requests === 1) {
            throw timeout;
          }
          return new Response(null);
        },
        defer: async () => NOW,
        sleep: async (durationMs) => {
          waits.push(durationMs);
        },
        now: () => NOW,
        random: () => 0.5,
      });
      expect(response.status).toBe(200);
      expect(requests).toBe(2);
      expect(waits).toEqual([1000]);
    });
  }

  test("caller cancellation during a wait stops before the next request", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller stopped ingestion", "AbortError");
    let requests = 0;
    const pending = retryPublisherRequest(
      URL,
      { ...INIT, signal: controller.signal },
      {
        request: async () => {
          requests += 1;
          return new Response(null, { status: 503 });
        },
        defer: async () => NOW,
        sleep: async (_durationMs, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(reason);
          throw reason;
        },
        now: () => NOW,
        random: () => 0.5,
      },
    );
    expect(
      await pending.then(
        () => "accepted",
        (error: unknown) => error,
      ),
    ).toBe(reason);
    expect(requests).toBe(1);
  });

  test("unrelated network faults propagate without retry", async () => {
    const reason = new TypeError("Connection refused");
    let requests = 0;
    const pending = retryPublisherRequest(URL, INIT, {
      request: async () => {
        requests += 1;
        throw reason;
      },
      defer: async () => NOW,
      sleep: async () => {},
      now: () => NOW,
      random: () => 0.5,
    });
    expect(
      await pending.then(
        () => "accepted",
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(AdapterFetchError);
    expect(
      await pending.then(
        () => "accepted",
        (error: unknown) => error,
      ),
    ).toMatchObject({ cause: reason });
    expect(requests).toBe(1);
  });
});

describe("bounded full jitter and publisher minimum waits", () => {
  test("jitter spans the exponential window and applies its cap before sampling", () => {
    const delay = (attempt: number, random: number) =>
      publisherRetryDelay({ attempt, retryAfter: null, now: NOW, random });
    expect(delay(0, 0)).toBe(0);
    expect(delay(0, 0.25)).toBe(500);
    expect(delay(1, 0.75)).toBe(3000);
    expect(delay(20, 0.5)).toBe(150_000);
    expect(delay(20, 0.999)).toBe(299_700);
  });

  test("every wait honors a bounded Retry-After and total waits remain bounded", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            attempt: fc.integer({ min: 0, max: 30 }),
            seconds: fc.integer({ min: 0, max: 2_000_000 }),
            random: fc.double({ min: 0, max: 0.999999, noNaN: true }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (inputs) => {
          const waits = inputs.map(({ attempt, seconds, random }) => {
            const minimum = Math.min(seconds * 1000, 900_000);
            const wait = publisherRetryDelay({
              attempt,
              retryAfter: String(seconds),
              now: NOW,
              random,
            });
            expect(wait).toBeGreaterThanOrEqual(minimum);
            expect(wait).toBeLessThanOrEqual(900_000);
            return wait;
          });
          expect(
            waits.reduce((total, wait) => total + wait, 0),
          ).toBeLessThanOrEqual(900_000 * inputs.length);
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("without Retry-After every jittered wait remains within the exponential cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (attempt, random) => {
          const wait = publisherRetryDelay({
            attempt,
            retryAfter: null,
            now: NOW,
            random,
          });
          expect(wait).toBeGreaterThanOrEqual(0);
          expect(wait).toBeLessThanOrEqual(300_000);
          expect(wait).toBeLessThanOrEqual(2000 * 2 ** attempt);
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
