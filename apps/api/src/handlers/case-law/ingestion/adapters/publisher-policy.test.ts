import { afterEach, describe, expect, it, mock, test } from "bun:test";

import {
  ADAPTER_PUBLISHER_GATES,
  createPublisherSlot,
  publisherRequestIntervalMs,
  publisherRequestsPerDay,
  PUBLISHER_GATES,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { connectedGateClient } from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
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

  test("costs one request and is handed back, never retried", async () => {
    let requests = 0;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests += 1;
        return new Response("", { status: 429 });
      }),
    );

    const response = await fetchWithRetry(
      "https://ris.bka.gv.at/x",
      undefined,
      {
        adapterKey: ADAPTER_KEYS.AT_COURTS,
        maxRetries: 2,
      },
    );

    // Rule 19a: no retry clears the refusal, and the budget a retry would
    // spend is the budget the halt protects. The caller holds its cursor.
    expect(response.status).toBe(429);
    expect(requests).toBe(1);
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
        adapterKey: ADAPTER_KEYS.AT_COURTS,
        maxRetries: 2,
      },
    );

    expect(response.status).toBe(503);
    expect(requests).toBe(3);
  });
});

describe("the gate's own Redis client", () => {
  it("connects before it issues the first reservation", async () => {
    const calls: string[] = [];
    const client = {
      connect: async () => {
        calls.push("connect");
      },
      send: () => {
        calls.push("send");
        return 0;
      },
    };
    const gateClient = connectedGateClient(async () => client);

    (await gateClient()).send("EVAL", []);
    (await gateClient()).send("EVAL", []);

    // One connect, and it precedes every command: the offline queue is off,
    // so a command issued before the handshake is rejected, not queued.
    expect(calls).toEqual(["connect", "send", "send"]);
  });

  it("builds one client for reservations that race the first connection", async () => {
    // Every adapter runs its own loop, so the first reservations arrive
    // together. A second client installed over the first would be handed out
    // unconnected, and its command rejected, because the handshake being
    // awaited belongs to the client it replaced.
    let clients = 0;
    const createClient = async () => {
      clients += 1;
      await Promise.resolve();
      let connected = false;
      return {
        connect: async () => {
          await Promise.resolve();
          connected = true;
        },
        send: () => {
          if (!connected) {
            throw new Error(
              "Connection is closed and offline queue is disabled",
            );
          }
          return 0;
        },
      };
    };
    const gateClient = connectedGateClient(createClient);

    const waits = await Promise.all(
      Array.from({ length: 8 }, async () =>
        (await gateClient()).send("EVAL", []),
      ),
    );

    expect(clients).toBe(1);
    expect(waits).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("retries the connection on the next reservation after one fails", async () => {
    let attempts = 0;
    const client = {
      connect: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("connection refused");
        }
      },
      send: () => 0,
    };
    const gateClient = connectedGateClient(async () => client);

    const rejection = await rejectionOf(gateClient());
    expect(rejection).toMatchObject({ message: "connection refused" });

    await gateClient();

    expect(attempts).toBe(2);
  });
});
