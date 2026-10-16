import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import {
  PROVIDER_RETRY_WAIT_CAP_MS,
  providerRetryDelayMs,
} from "@/api/lib/errors/provider-retry-delay";

const FIXTURES = path.join(
  import.meta.dir,
  "../../tests/fixtures/provider-wire",
);

// What each provider's recorded rate-limit answer asks for. Every provider
// with fixtures must be listed, so a new provider decides its row here.
const EXPECTED_DELAY_MS: Record<string, number | undefined> = {
  anthropic: 1000,
  bedrock: undefined,
  google: 12_000,
  mistral: undefined,
  openai: 62,
  openrouter: undefined,
};

const WIRE_FIXTURE = v.object({
  exchanges: v.array(
    v.object({
      response: v.object({
        status: v.number(),
        headers: v.optional(v.record(v.string(), v.string())),
        body: v.optional(v.object({ encoding: v.string(), text: v.string() })),
      }),
    }),
  ),
});

type WireResponse = v.InferOutput<
  typeof WIRE_FIXTURE
>["exchanges"][number]["response"];

const rateLimitResponses = (provider: string): WireResponse[] =>
  readdirSync(path.join(FIXTURES, provider))
    .filter((name) => name.startsWith("rate-limit"))
    .map((name) => {
      const fixture = v.parse(
        WIRE_FIXTURE,
        JSON.parse(readFileSync(path.join(FIXTURES, provider, name), "utf-8")),
      );
      return (
        fixture.exchanges.at(-1)?.response ?? panic(`${name}: no exchange`)
      );
    });

// The two shapes an SDK hands over: the response headers on the error, and
// the body text as the message (parsed or not).
const sdkError = (response: WireResponse) =>
  Object.assign(new Error(response.body?.text ?? ""), {
    status: response.status,
    headers: new Headers(response.headers ?? {}),
  });

describe("providerRetryDelayMs over recorded rate-limit answers", () => {
  test("every provider with fixtures has an expected delay", () => {
    const providers = readdirSync(FIXTURES).toSorted();
    expect(Object.keys(EXPECTED_DELAY_MS).toSorted()).toEqual(providers);
  });

  for (const [provider, expected] of Object.entries(EXPECTED_DELAY_MS)) {
    test(`${provider}: ${String(expected)} ms`, () => {
      const responses = rateLimitResponses(provider);
      expect(responses.length).toBeGreaterThan(0);
      for (const response of responses) {
        expect(providerRetryDelayMs(sdkError(response))).toBe(expected);
        // The same failure wrapped the way the service wraps it.
        expect(providerRetryDelayMs({ cause: sdkError(response) })).toBe(
          expected,
        );
      }
    });
  }
});

describe("providerRetryDelayMs sources", () => {
  const now = Temporal.Instant.from("2026-10-16T08:00:00Z").epochMilliseconds;

  test("retry-after-ms wins over retry-after", () => {
    expect(
      providerRetryDelayMs({
        headers: { "retry-after-ms": "250", "retry-after": "9" },
      }),
    ).toBe(250);
  });

  test("plain header objects match names in any case", () => {
    expect(providerRetryDelayMs({ headers: { "Retry-After": "7" } })).toBe(
      7000,
    );
    expect(
      providerRetryDelayMs({
        response: { headers: { "Retry-After-Ms": "120", "RETRY-AFTER": "9" } },
      }),
    ).toBe(120);
  });

  test("retry-after as an HTTP date counts from now and never goes negative", () => {
    expect(
      providerRetryDelayMs(
        { headers: { "retry-after": "Fri, 16 Oct 2026 08:00:20 GMT" } },
        now,
      ),
    ).toBe(20_000);
    expect(
      providerRetryDelayMs(
        { headers: { "retry-after": "Fri, 16 Oct 2026 07:59:00 GMT" } },
        now,
      ),
    ).toBe(0);
  });

  test("a Response on the error carries the header", () => {
    const rawResponse = new Response(null, {
      status: 429,
      headers: { "retry-after": "3" },
    });
    expect(providerRetryDelayMs({ cause: { rawResponse } })).toBe(3000);
  });

  test("RetryInfo wins over a delay the message states", () => {
    expect(
      providerRetryDelayMs({
        error: {
          message: "Please retry in 41.7s.",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "40.5s",
            },
          ],
        },
      }),
    ).toBe(40_500);
  });

  test("a long quota delay is read whole, past the wait cap", () => {
    const delay = providerRetryDelayMs({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "41400s",
          },
        ],
      },
    });
    expect(delay).toBe(41_400_000);
    expect(delay).toBeGreaterThan(PROVIDER_RETRY_WAIT_CAP_MS);
  });

  test("prose in seconds and milliseconds", () => {
    expect(providerRetryDelayMs(new Error("try again in 1.2 seconds"))).toBe(
      1200,
    );
    expect(providerRetryDelayMs(new Error("Please try again in 62ms."))).toBe(
      62,
    );
  });

  test("no stated delay, malformed values and cycles give undefined", () => {
    const cyclic: Record<string, unknown> = { message: "rate limited" };
    cyclic["cause"] = cyclic;
    expect(providerRetryDelayMs(cyclic)).toBeUndefined();
    expect(
      providerRetryDelayMs({ headers: { "retry-after": "soon" } }),
    ).toBeUndefined();
    expect(providerRetryDelayMs("429")).toBeUndefined();
    expect(providerRetryDelayMs(undefined)).toBeUndefined();
  });
});
