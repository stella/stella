import { afterEach, describe, expect, it, mock, test } from "bun:test";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import {
  ADAPTER_PUBLISHER_GATES,
  createPublisherSlot,
  createPublisherGateSlot,
  deferPublisherGate,
  publisherRequestIntervalMs,
  publisherRequestsPerDay,
  PUBLISHER_GATES,
  readPublisherCooldown,
  withPublisherRequestRateLimit,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { publisherGateKeys } from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import {
  fetchPublisher,
  fetchWithRetry,
} from "@/api/handlers/case-law/ingestion/adapters/retry";
import { rejectionOf } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

describe("the shared publisher gate", () => {
  it("does not validate Redis configuration until a deployed request", () => {
    const environment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "REDIS_URL" && key !== "STELLA_LOCAL_DEV",
        ),
      ),
      NODE_ENV: "production",
    };
    const moduleUrl = new URL("publisher-request-gate.ts", import.meta.url)
      .href;
    const imported = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      env: environment,
    });

    expect(imported.exitCode).toBe(0);
    expect(imported.stderr.toString()).toBe("");
  });

  it("reserves every concurrent request against the shared Redis key", async () => {
    const waits = [0, 5000, 10_000];
    const commands: string[][] = [];
    const sleeps: number[] = [];
    const reserve = createPublisherSlot(ADAPTER_KEYS.AT_COURTS, {
      redis: () => ({
        send: async (_command, args) => {
          commands.push(args);
          return waits.at(commands.length - 1);
        },
      }),
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
      },
    });

    await Promise.all([reserve(), reserve(), reserve()]);

    expect(sleeps).toEqual(waits);
    expect(commands).toHaveLength(3);
    for (const args of commands) {
      expect(args.slice(1)).toEqual([
        "1",
        "case-law:publisher-gate:ris-bka",
        "5000",
      ]);
    }
  });

  it("spends one budget for every adapter naming the same publisher", async () => {
    const keys: string[] = [];
    const reserveFor = (
      adapterKey: Parameters<typeof createPublisherSlot>[0],
    ) =>
      createPublisherSlot(adapterKey, {
        redis: () => ({
          send: (_command, args) => {
            keys.push(args[2] ?? "");
            return 0;
          },
        }),
        sleep: async () => {},
      });

    await reserveFor(ADAPTER_KEYS.AT_VFGH)();
    await reserveFor(ADAPTER_KEYS.AT_BKS)();
    await reserveFor(ADAPTER_KEYS.AT_FINDOK)();

    expect(keys).toEqual([
      "case-law:publisher-gate:ris-bka",
      "case-law:publisher-gate:ris-bka",
      "case-law:publisher-gate:findok-bmf",
    ]);
  });

  it("keeps the Austrian and Polish intervals", () => {
    expect(publisherRequestIntervalMs(ADAPTER_KEYS.AT_COURTS)).toBe(5000);
    expect(publisherRequestIntervalMs(ADAPTER_KEYS.AT_FINDOK)).toBe(1500);
    expect(publisherRequestIntervalMs(ADAPTER_KEYS.PL_SN)).toBe(1500);
  });

  it("derives a daily ceiling from the interval it enforces", () => {
    for (const adapterKey of Object.values(ADAPTER_KEYS)) {
      const gateId = ADAPTER_PUBLISHER_GATES[adapterKey];
      expect(PUBLISHER_GATES[gateId]).toBeDefined();
      expect(publisherRequestsPerDay(gateId)).toBe(
        Math.floor(86_400_000 / publisherRequestIntervalMs(adapterKey)),
      );
    }
    // NALUS is the one publisher that stated a total rather than a gap, and
    // the interval derived from it has to stay under what the court allows.
    expect(publisherRequestsPerDay("nalus-usoud")).toBeLessThan(5000);
  });

  it("fails closed when Redis returns an invalid reservation", async () => {
    const reserve = createPublisherSlot(ADAPTER_KEYS.AT_COURTS, {
      redis: () => ({ send: async () => "not-a-number" }),
      sleep: async () => {
        throw new Error("invalid reservations must not reach sleep");
      },
    });

    const rejection = await rejectionOf(reserve());
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("invalid wait"),
    });
  });

  it("abandons a Redis reservation when the ingestion signal aborts", async () => {
    const controller = new AbortController();
    const reserve = createPublisherSlot(ADAPTER_KEYS.AT_COURTS, {
      redis: () => ({ send: async () => await new Promise(() => {}) }),
      sleep: async () => {
        throw new Error("an unreserved request must not sleep");
      },
    });

    const pending = reserve(controller.signal);
    controller.abort(new DOMException("Stopped", "AbortError"));

    const rejection = await rejectionOf(pending);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("Stopped"),
    });
  });
});

describe("a publisher's rate-limit refusal", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test.each([401, 403, 429])(
    "%s costs one request and stops with a typed refusal, never retried",
    async (httpStatus) => {
      let requests = 0;
      globalThis.fetch = asFetchMock(
        mock(async () => {
          requests += 1;
          return new Response("", { status: httpStatus });
        }),
      );

      const error = await rejectionOf(
        fetchWithRetry("https://ris.bka.gv.at/x", undefined, {
          fetchStage: "listing",
          adapterKey: ADAPTER_KEYS.AT_COURTS,
          maxRetries: 2,
          refusalMode: "stop-refusal",
        }),
      );

      // Rule 19a: no retry clears the refusal, and the budget a retry would
      // spend is the budget the halt protects. The caller holds its cursor.
      expect(error).toMatchObject({
        httpStatus,
        stopKind: "publisher_refusal",
      });
      expect(requests).toBe(1);
    },
  );

  test.each([401, 403, 429])(
    "an existing document workflow receives %s without retries",
    async (status) => {
      let requests = 0;
      globalThis.fetch = asFetchMock(
        mock(async () => {
          requests++;
          return new Response("refused document", { status });
        }),
      );
      const response = await fetchWithRetry(
        "https://ris.bka.gv.at/x",
        undefined,
        {
          fetchStage: "listing",
          adapterKey: ADAPTER_KEYS.AT_COURTS,
        },
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("refused document");
      expect(requests).toBe(1);
    },
  );

  for (const refusalMode of [
    undefined,
    "return-response",
    "stop-refusal",
  ] as const) {
    test.each([401, 403])(
      `the real publisher-backoff path preserves status in mode ${refusalMode ?? "default"}`,
      async (status) => {
        let requests = 0;
        globalThis.fetch = asFetchMock(
          mock(async () => {
            requests++;
            return new Response("refused document", { status });
          }),
        );
        const pending = fetchPublisher("https://ris.bka.gv.at/x", {
          fetchStage: "listing",
          adapterKey: ADAPTER_KEYS.AT_COURTS,
          retryPolicy: "publisher-backoff",
          timeoutMs: 1000,
          refusalMode,
        });
        if (refusalMode === "stop-refusal") {
          expect(await rejectionOf(pending)).toMatchObject({
            httpStatus: status,
            stopKind: "publisher_refusal",
          });
        } else {
          const response = await pending;
          expect(response.status).toBe(status);
          expect(await response.text()).toBe("refused document");
        }
        expect(requests).toBe(1);
      },
    );
  }

  test("legacy fetch timeouts keep their original identity", async () => {
    const failure = new DOMException("Request timed out", "TimeoutError");
    globalThis.fetch = asFetchMock(
      mock(async () => {
        throw failure;
      }),
    );
    const caught = await rejectionOf(
      fetchWithRetry("https://ris.bka.gv.at/x", undefined, {
        fetchStage: "listing",
        adapterKey: ADAPTER_KEYS.AT_COURTS,
        maxRetries: 0,
      }),
    );
    expect(caught).toBe(failure);
  });

  test("still retries a 5xx, which is the publisher failing to answer", async () => {
    let requests = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests += 1;
        return new Response("", { status: 503 });
      }),
    );
    Bun.sleep = async () => {};

    const response = await fetchWithRetry(
      "https://ris.bka.gv.at/x",
      undefined,
      {
        fetchStage: "listing",
        adapterKey: ADAPTER_KEYS.AT_COURTS,
        maxRetries: 2,
      },
    );

    expect(response.status).toBe(503);
    expect(requests).toBe(3);
  });
});

describe("a run-scoped publisher rate limit", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  const createGateClock = () => {
    let now = 0;
    let nextSlot = 0;
    let cooldownUntil = 0;
    const reservations: string[][] = [];
    const dependencies = {
      redis: () => ({
        send: (_command: string, args: string[]) => {
          if (args.length === 5) {
            reservations.push(args);
            const intervalMs = Number(args.at(-1));
            const slot = Math.max(now, nextSlot, cooldownUntil);
            nextSlot = slot + intervalMs;
            return slot - now;
          }
          if (args.length === 4) {
            cooldownUntil = Math.max(cooldownUntil, now + Number(args.at(-1)));
            return cooldownUntil - now;
          }
          return cooldownUntil > now ? cooldownUntil - now : 0;
        },
      }),
      sleep: async (durationMs: number) => {
        now += durationMs;
      },
    };
    return { dependencies, reservations, now: () => now };
  };

  test("counts listing, notice, HTML, and every Formex retry in the run window", async () => {
    let formexAttempts = 0;
    const requests: { url: string; time: number }[] = [];
    const clock = createGateClock();
    globalThis.fetch = asFetchMock(
      mock(async (input) => {
        const url = String(input);
        requests.push({ url, time: clock.now() });
        if (url.endsWith("/formex") && formexAttempts++ === 0) {
          return new Response("", { status: 503 });
        }
        return new Response("", { status: 200 });
      }),
    );
    Bun.sleep = async () => {};

    const response = await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 2,
      dependencies: clock.dependencies,
      operation: async () => {
        const publisher = "https://publications.europa.eu";
        const listing = await fetchPublisher(`${publisher}/listing`, {
          fetchStage: "listing",
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        });
        const notice = await fetchPublisher(`${publisher}/notice`, {
          fetchStage: "document",
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        });
        const html = await fetchPublisher(`${publisher}/html`, {
          fetchStage: "document",
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        });
        const formex = await fetchWithRetry(`${publisher}/formex`, undefined, {
          fetchStage: "document",
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        });
        return { listing, notice, html, formex };
      },
    });

    expect(Object.values(response).map((result) => result.status)).toEqual([
      200, 200, 200, 200,
    ]);
    const reservations = clock.reservations;
    expect(reservations).toHaveLength(5);
    expect(reservations.map((args) => args.at(-1))).toEqual([
      "1000",
      "1000",
      "1000",
      "1000",
      "1000",
    ]);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/listing",
      "/notice",
      "/html",
      "/formex",
      "/formex",
    ]);
    expect(requests.map(({ time }) => time)).toEqual([
      0, 1000, 2000, 3000, 4000,
    ]);
    for (const { time } of requests) {
      expect(
        requests.filter(
          (request) => request.time >= time && request.time < time + 1000,
        ).length,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("the shared EU cooldown still blocks requests inside a scoped rate run", async () => {
    const clock = createGateClock();
    const { key, cooldownKey } = publisherGateKeys("cellar-eu");
    const requestTimes: number[] = [];
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requestTimes.push(clock.now());
        return new Response("", { status: 200 });
      }),
    );

    const cooldownUntil = await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 1,
      dependencies: clock.dependencies,
      operation: async () => {
        const deferred = await deferPublisherGate("cellar-eu", 5000);
        const sharedDeadline = await readPublisherCooldown("cellar-eu");
        const first = await fetchPublisher(
          "https://publications.europa.eu/formex",
          {
            fetchStage: "document",
            adapterKey: ADAPTER_KEYS.EU_ECJ,
            timeoutMs: ADAPTER_TIMEOUT.REQUEST,
          },
        );
        const second = await fetchPublisher(
          "https://publications.europa.eu/formex",
          {
            fetchStage: "document",
            adapterKey: ADAPTER_KEYS.EU_ECJ,
            timeoutMs: ADAPTER_TIMEOUT.REQUEST,
          },
        );
        return { deferred, sharedDeadline, first, second };
      },
    });

    expect(cooldownUntil.deferred).toBe(5000);
    expect(cooldownUntil.sharedDeadline).toBe(5000);
    expect(cooldownUntil.first.status).toBe(200);
    expect(cooldownUntil.second.status).toBe(200);
    expect(requestTimes).toEqual([5000, 6000]);
    expect(clock.reservations.at(0)?.slice(2, 4)).toEqual([key, cooldownKey]);
    expect(clock.reservations.map((args) => args.at(-1))).toEqual([
      "1000",
      "1000",
    ]);
  });

  test("rejects rates above the gate's two requests per second", async () => {
    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the refusal explicitly instead.
    const refusal = await withPublisherRequestRateLimit({
      gateId: "cellar-eu",
      requestsPerSecond: 2.01,
      operation: async () => "unreachable",
    }).then(
      () => "accepted",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    expect(refusal).toContain("at most 2");
  });
});

test("crawl and completion share one EU request per second", async () => {
  let now = 0;
  const nextByKey = new Map<string, number>();
  const keys: string[] = [];
  const dependencies = {
    redis: () => ({
      send: (_command: string, args: string[]) => {
        if (args.length === 3) {
          return 0;
        }
        const key = args.at(2);
        if (key === undefined) {
          return expect.unreachable();
        }
        keys.push(key);
        const slot = Math.max(now, nextByKey.get(key) ?? 0);
        nextByKey.set(key, slot + Number(args.at(-1)));
        return slot - now;
      },
    }),
    sleep: async (durationMs: number) => {
      now += durationMs;
    },
  };
  const crawl = createPublisherSlot(ADAPTER_KEYS.EU_ECJ, dependencies);
  const completion = createPublisherGateSlot("cellar-eu", dependencies);
  const starts: number[] = [];
  for (const slot of [crawl, completion, crawl, completion]) {
    await slot();
    starts.push(now);
  }
  expect(starts).toEqual([0, 1000, 2000, 3000]);
  expect(new Set(keys).size).toBe(1);
  for (const start of starts) {
    expect(
      starts.filter((time) => time >= start && time < start + 1000),
    ).toHaveLength(1);
  }
});
