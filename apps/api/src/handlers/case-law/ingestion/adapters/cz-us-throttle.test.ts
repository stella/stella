import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";
import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";
import { DAY_IN_MS } from "@stll/time";

import {
  createNalusFetch,
  NALUS_REQUEST_INTERVAL_MS,
  NalusRateLimitedError,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us-throttle";
import { NALUS_DAILY_REQUEST_LIMIT } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { rejectionOf } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { isReadRefusal } from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { withDocumentStageWindow } from "@/api/lib/legal-search/document-stage-observation";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
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

  test.each([401, 403, 451])(
    "HTTP %i returns a typed refusal result",
    async (status) => {
      globalThis.fetch = asFetchMock(
        async () => new Response(null, { status }),
      );
      const { fetchNalus, trace } = gatedFetch();
      const result = await fetchNalus(
        "https://nalus.usoud.cz/Search/GetText.aspx?sz=fixture",
        { fetchStage: "listing" },
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(AdapterFetchError);
        expect(isReadRefusal(result.error.cause)).toBe(true);
        expect(result.error.cause).toMatchObject({
          type: "refused",
          scope: "source",
          status,
        });
        if (result.error instanceof AdapterFetchError) {
          expect(result.error.stopKind).toBe(
            INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
          );
          expect(result.error.httpStatus).toBe(status);
        }
      }
      expect(trace.reservations).toHaveLength(1);
    },
  );

  test("document requests emit typed publisher refusals while listing requests stay outside document accounting", async () => {
    for (const fetchStage of ["document", "listing"] as const) {
      const observations: DocumentStageObservation[] = [];
      globalThis.fetch = asFetchMock(
        mock(
          async () =>
            new Response(null, {
              status: 302,
              headers: {
                Location: "https://nalus.usoud.cz/limit-exceeded.html",
              },
            }),
        ),
      );
      const { fetchNalus } = gatedFetch();
      await withDocumentStageWindow({
        source: ADAPTER_KEYS.CZ_US,
        now: () => 0,
        observe: (event) => {
          observations.push(event);
        },
        fetchPage: async () => {
          const result = await fetchNalus(
            "https://nalus.usoud.cz/Search/GetText.aspx?sz=fixture",
            { fetchStage },
          );
          expect(Result.isError(result)).toBe(true);
          return Result.ok({ decisions: [], nextCursor: null });
        },
      });
      if (fetchStage === "document") {
        expect(observations.at(0)).toEqual({
          event: DOCUMENT_FETCH_EVENT.fetchOutcome,
          source: ADAPTER_KEYS.CZ_US,
          outcome: "rate_limited",
          http_status: 302,
        });
        expect(observations.at(-1)).toMatchObject({
          aggregation: "page",
          attempted: 1,
          failed: 1,
        });
      } else {
        expect(observations).toEqual([
          {
            event: DOCUMENT_FETCH_EVENT.window,
            aggregation: "page",
            source: ADAPTER_KEYS.CZ_US,
            backlog: 0,
            attempted: 0,
            filled: 0,
            failed: 0,
            window_seconds: 0,
          },
        ]);
      }
    }
  });

  test("spends fewer requests a day than the court states it allows", () => {
    const requestsPerDay = DAY_IN_MS / NALUS_REQUEST_INTERVAL_MS;

    expect(requestsPerDay).toBeLessThan(NALUS_DAILY_REQUEST_LIMIT);
  });

  test("reserves a slot before every request, against the shared key", async () => {
    globalThis.fetch = asFetchMock(mock(async () => new Response()));
    const { fetchNalus, trace } = gatedFetch();

    await fetchNalus("https://nalus.usoud.cz/Search/Search.aspx", {
      fetchStage: "listing",
    });
    await fetchNalus("https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1-93_1", {
      fetchStage: "document",
    });
    await fetchNalus(
      "https://nalus.usoud.cz/Search/GetAbstract.aspx?sz=1-1-93_1",
      { fetchStage: "document" },
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

    await fetchNalus("https://nalus.usoud.cz/Search/Search.aspx", {
      fetchStage: "listing",
    });

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
      { fetchStage: "listing" },
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
      { fetchStage: "document" },
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
      {
        fetchStage: "listing",
        method: "POST",
        body: "ctl00%24MainContent%24but_search=Vyhledat",
      },
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
      fetchNalus("https://nalus.usoud.cz.attacker.example/Search/Search.aspx", {
        fetchStage: "listing",
      }),
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(trace.reservations).toEqual([]);
  });
});
