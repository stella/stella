import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { withPublisherRequestRateLimit } from "./publisher-policy";
import {
  fetchPublisher,
  fetchWithRetry,
  PublisherRateLimitRefusalError,
} from "./retry";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const target = "https://publications.europa.eu/completion-fixture";
const fixture = (failCooldown = false) => {
  let clock = 0;
  let slot = 0;
  let cooldown = 0;
  let charges = 0;
  let enabled = true;
  let refused: number | null = null;
  const dependencies = {
    redis: () => ({
      send: (_command: string, args: string[]) => {
        if (args.at(2)?.endsWith(":cooldown")) {
          if (args.length === 5) {
            if (failCooldown) {
              throw new TypeError("fixture cooldown unavailable");
            }
            cooldown = Math.max(cooldown, clock + Number(args.at(3)));
            return cooldown;
          }
          return Math.max(0, cooldown - clock);
        }
        const wait = Math.max(clock, slot, cooldown) - clock;
        slot = clock + wait + Number(args.at(-1));
        return wait;
      },
    }),
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const controls = {
    retry: "durable" as const,
    check: async () => {
      if (refused !== null) {
        return Result.err(new TypeError("fixture publisher refused"));
      }
      if (!enabled) {
        return Result.err(new TypeError("fixture disabled"));
      }
      return Result.ok();
    },
    raiseFailure: (error: unknown): never => {
      throw error;
    },
    checkBeforeSend: () =>
      enabled ? Result.ok() : Result.err(new TypeError("fixture disabled")),
    chargeRequest: async () => {
      charges++;
      return Result.ok();
    },
    onRefusal: (deadline: number) => {
      refused = deadline;
    },
  };
  return {
    dependencies,
    controls,
    charges: () => charges,
    cooldown: () => cooldown,
    advance: (ms: number) => {
      clock += ms;
    },
    refused: () => refused,
    disable: () => {
      enabled = false;
    },
    now: () => clock,
  };
};
describe("completion request boundary", () => {
  test("slow budget bookkeeping cannot compress send spacing", async () => {
    const state = fixture();
    const sent: number[] = [];
    let charged = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        sent.push(state.now());
        return new Response("fixture");
      }),
    );
    await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 1,
      dependencies: state.dependencies,
      controls: {
        ...state.controls,
        chargeRequest: async () => {
          if (charged++ === 0) {
            state.advance(1100);
          }
          return await state.controls.chargeRequest();
        },
      },
      operation: async () => {
        await fetchPublisher(target, {
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          fetchStage: "document",
          timeoutMs: 1000,
        });
        await fetchPublisher(target, {
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          fetchStage: "document",
          timeoutMs: 1000,
        });
      },
    });
    expect(sent).toEqual([1100, 2100]);
  });
  test.each([401, 403])(
    "HTTP %s refuses the run after one request",
    async (status) => {
      const state = fixture();
      let sent = 0;
      globalThis.fetch = asFetchMock(
        mock(async () => {
          sent++;
          return new Response(null, {
            status,
            headers: { "Retry-After": "60" },
          });
        }),
      );
      const response = await Result.tryPromise({
        try: async () =>
          await withPublisherRequestRateLimit({
            gateId: "cellar-eu",
            requestsPerSecond: 1,
            dependencies: state.dependencies,
            controls: state.controls,
            operation: async () =>
              await fetchPublisher(target, {
                adapterKey: ADAPTER_KEYS.EU_ECJ,
                fetchStage: "document",
                timeoutMs: 1000,
              }),
          }),
        catch: (error) => error,
      });
      expect(response.isErr()).toBe(true);
      if (response.isOk()) {
        expect.unreachable();
      }
      expect(response.error).toBeInstanceOf(PublisherRateLimitRefusalError);
      expect(sent).toBe(1);
      expect(state.refused()).not.toBeNull();
    },
  );

  test.each(["check", "charge"] as const)(
    "a returned %s Err prevents the HTTP effect",
    async (stage) => {
      const state = fixture();
      const failure = new TypeError(`fixture ${stage} refused`);
      let requests = 0;
      globalThis.fetch = asFetchMock(
        mock(async () => {
          requests++;
          return new Response("unexpected request");
        }),
      );
      const result = await Result.tryPromise({
        try: async () =>
          await withPublisherRequestRateLimit({
            gateId: "cellar-eu",
            requestsPerSecond: 1,
            dependencies: state.dependencies,
            controls: {
              ...state.controls,
              check: async () =>
                stage === "check" ? Result.err(failure) : Result.ok(),
              chargeRequest: async () =>
                stage === "charge"
                  ? Result.err(failure)
                  : await state.controls.chargeRequest(),
            },
            operation: async () =>
              await fetchPublisher(target, {
                adapterKey: ADAPTER_KEYS.EU_ECJ,
                fetchStage: "document",
                timeoutMs: 1000,
              }),
          }),
        catch: (error) => error,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe(failure);
      }
      expect(requests).toBe(0);
      expect(state.charges()).toBe(0);
    },
  );
  test("a refusal remains latched when cooldown persistence fails", async () => {
    const state = fixture(true);
    let requests = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests++;
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }),
    );
    await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 1,
      dependencies: state.dependencies,
      controls: state.controls,
      operation: async () => {
        const first = await Result.tryPromise(
          async () =>
            await fetchPublisher(target, {
              adapterKey: ADAPTER_KEYS.EU_ECJ,
              fetchStage: "document",
              timeoutMs: 1000,
            }),
        );
        const second = await Result.tryPromise(
          async () =>
            await fetchPublisher(target, {
              adapterKey: ADAPTER_KEYS.EU_ECJ,
              fetchStage: "document",
              timeoutMs: 1000,
            }),
        );
        expect(first.isErr()).toBe(true);
        expect(second.isErr()).toBe(true);
      },
    });
    expect(state.refused()).not.toBeNull();
    expect(requests).toBe(1);
    expect(state.charges()).toBe(1);
  });
  test("429 ends one request and retains a Retry-After longer than ordinary retry caps", async () => {
    const state = fixture();
    let requests = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests++;
        return new Response("refused", {
          status: 429,
          headers: { "Retry-After": "7200" },
        });
      }),
    );
    const result = await Result.tryPromise({
      try: async () =>
        await withPublisherRequestRateLimit({
          gateId: "cellar-eu",
          requestsPerSecond: 1,
          dependencies: state.dependencies,
          controls: state.controls,
          operation: async () =>
            await fetchPublisher(target, {
              adapterKey: ADAPTER_KEYS.EU_ECJ,
              fetchStage: "document",
              timeoutMs: 1000,
            }),
        }),
      catch: (error) => error,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      expect.unreachable();
    }
    expect(result.error).toBeInstanceOf(PublisherRateLimitRefusalError);
    expect(requests).toBe(1);
    expect(state.charges()).toBe(1);
    expect(state.refused()).toBeGreaterThanOrEqual(7_200_000);
    expect(state.cooldown()).toBeLessThanOrEqual(15 * 60_000);
  });
  test("publisher-backoff preserves refusal redirects before the redirect can be followed", async () => {
    const state = fixture();
    const visited: string[] = [];
    globalThis.fetch = asFetchMock(
      mock(async (input) => {
        visited.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { Location: `${target}/final`, "Retry-After": "60" },
        });
      }),
    );
    const result = await Result.tryPromise({
      try: async () =>
        await withPublisherRequestRateLimit({
          gateId: "cellar-eu",
          requestsPerSecond: 1,
          dependencies: state.dependencies,
          controls: state.controls,
          operation: async () =>
            await fetchPublisher(target, {
              adapterKey: ADAPTER_KEYS.EU_ECJ,
              fetchStage: "document",
              timeoutMs: 1000,
              retryPolicy: "publisher-backoff",
              isRateLimitRedirect: (response) => response.status === 302,
            }),
        }),
      catch: (error) => error,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(PublisherRateLimitRefusalError);
    }
    expect(visited).toEqual([target]);
    expect(state.charges()).toBe(1);
    expect(state.refused()).toBeGreaterThanOrEqual(60_000);
  });
  test("redirects consume separate paced and persisted requests", async () => {
    const state = fixture();
    const visited: number[] = [];
    globalThis.fetch = asFetchMock(
      mock(async () => {
        visited.push(state.now());
        return visited.length === 1
          ? new Response(null, {
              status: 302,
              headers: { Location: `${target}/final` },
            })
          : new Response("document");
      }),
    );
    const response = await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 1,
      dependencies: state.dependencies,
      controls: state.controls,
      operation: async () =>
        await fetchPublisher(target, {
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          fetchStage: "document",
          timeoutMs: 1000,
        }),
    });
    expect(response.status).toBe(200);
    expect(visited).toEqual([0, 1000]);
    expect(state.charges()).toBe(2);
  });
  test("durable completion never loops a transient publisher answer", async () => {
    const state = fixture();
    let requests = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests++;
        return new Response("unavailable", { status: 503 });
      }),
    );
    const response = await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 1,
      dependencies: state.dependencies,
      controls: state.controls,
      operation: async () =>
        await fetchWithRetry(target, undefined, {
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          fetchStage: "document",
          maxRetries: 5,
        }),
    });
    expect(response.status).toBe(503);
    expect(requests).toBe(1);
    expect(state.charges()).toBe(1);
  });
  test("a kill after the first response prevents a redirected request", async () => {
    const state = fixture();
    let requests = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests++;
        state.disable();
        return new Response(null, {
          status: 302,
          headers: { Location: `${target}/final` },
        });
      }),
    );
    const result = await Result.tryPromise({
      try: async () =>
        await withPublisherRequestRateLimit({
          gateId: "cellar-eu",
          requestsPerSecond: 1,
          dependencies: state.dependencies,
          controls: state.controls,
          operation: async () =>
            await fetchPublisher(target, {
              adapterKey: ADAPTER_KEYS.EU_ECJ,
              fetchStage: "document",
              timeoutMs: 1000,
            }),
        }),
      catch: (error) => error,
    });
    expect(result.isErr()).toBe(true);
    expect(requests).toBe(1);
    expect(state.charges()).toBe(1);
  });
});
