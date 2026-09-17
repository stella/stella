import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { DAY_IN_MS } from "@stll/time";

import {
  createNalusFetch,
  NALUS_REQUEST_INTERVAL_MS,
  NalusRateLimitedError,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us-throttle";
import { NALUS_DAILY_REQUEST_LIMIT } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { rejectionOf } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

type GateTrace = {
  reservations: string[][];
  sleeps: number[];
};

const gatedFetch = (): {
  fetchNalus: ReturnType<typeof createNalusFetch>;
  trace: GateTrace;
} => {
  const trace: GateTrace = { reservations: [], sleeps: [] };
  return {
    fetchNalus: createNalusFetch({
      redis: () => ({
        send: async (_command, args) => {
          trace.reservations.push(args);
          return 0;
        },
      }),
      sleep: async (durationMs) => {
        trace.sleeps.push(durationMs);
      },
    }),
    trace,
  };
};

describe("the NALUS publisher budget", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("spends fewer requests a day than the court states it allows", () => {
    const requestsPerDay = DAY_IN_MS / NALUS_REQUEST_INTERVAL_MS;

    expect(requestsPerDay).toBeLessThan(NALUS_DAILY_REQUEST_LIMIT);
  });

  test("reserves a slot before every request, against the shared key", async () => {
    globalThis.fetch = asFetchMock(mock(async () => new Response()));
    const { fetchNalus, trace } = gatedFetch();

    await fetchNalus("https://nalus.usoud.cz/Search/Search.aspx");
    await fetchNalus("https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1-93_1");
    await fetchNalus(
      "https://nalus.usoud.cz/Search/GetAbstract.aspx?sz=1-1-93_1",
    );

    expect(trace.reservations).toHaveLength(3);
    for (const args of trace.reservations) {
      expect(args.slice(1)).toEqual([
        "1",
        "case-law:publisher-gate:nalus-usoud",
        String(NALUS_REQUEST_INTERVAL_MS),
      ]);
    }
  });

  test("waits out the reservation before the request leaves", async () => {
    const order: string[] = [];
    globalThis.fetch = asFetchMock(
      mock(async () => {
        order.push("fetch");
        return new Response();
      }),
    );
    const fetchNalus = createNalusFetch({
      redis: () => ({ send: () => 18_000 }),
      sleep: async (durationMs) => {
        order.push(`sleep:${durationMs}`);
      },
    });

    await fetchNalus("https://nalus.usoud.cz/Search/Search.aspx");

    expect(order).toEqual(["sleep:18000", "fetch"]);
  });

  test("turns the court's limit redirect into a typed refusal", async () => {
    globalThis.fetch = asFetchMock(
      mock(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://nalus.usoud.cz/limit-exceeded.html" },
          }),
      ),
    );
    const { fetchNalus } = gatedFetch();

    const refusal = await fetchNalus(
      "https://nalus.usoud.cz/Search/Search.aspx",
    );

    expect(Result.isError(refusal)).toBe(true);
    const error = Result.isError(refusal) ? refusal.error : undefined;
    expect(error).toBeInstanceOf(NalusRateLimitedError);
    expect(error).toMatchObject({
      httpStatus: 302,
      message: expect.stringContaining(String(NALUS_DAILY_REQUEST_LIMIT)),
    });
  });

  test("turns a plain 429 into the same refusal", async () => {
    globalThis.fetch = asFetchMock(
      mock(async () => new Response("", { status: 429 })),
    );
    const { fetchNalus } = gatedFetch();

    const refusal = await fetchNalus(
      "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1-93_1",
    );

    expect(Result.isError(refusal)).toBe(true);
    const error = Result.isError(refusal) ? refusal.error : undefined;
    expect(error).toBeInstanceOf(NalusRateLimitedError);
    expect(error).toMatchObject({ httpStatus: 429 });
  });

  test("hands back the search form's own 302 unchanged", async () => {
    globalThis.fetch = asFetchMock(
      mock(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "/Search/Results.aspx" },
          }),
      ),
    );
    const { fetchNalus } = gatedFetch();

    const response = await fetchNalus(
      "https://nalus.usoud.cz/Search/Search.aspx",
      { method: "POST", body: "ctl00%24MainContent%24but_search=Vyhledat" },
    );

    expect(Result.isOk(response) && response.value.status).toBe(302);
  });

  test("refuses a URL outside the publisher, without spending a slot", async () => {
    globalThis.fetch = asFetchMock(
      mock(() => {
        throw new Error("a request outside NALUS must never be sent");
      }),
    );
    const { fetchNalus, trace } = gatedFetch();

    const rejection = await rejectionOf(
      fetchNalus("https://nalus.usoud.cz.attacker.example/Search/Search.aspx"),
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(trace.reservations).toEqual([]);
  });
});
