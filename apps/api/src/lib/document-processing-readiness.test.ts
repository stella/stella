import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isTransientRedisConnectionError } from "@/api/lib/redis-client";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

let readinessSend = async (
  _command: string,
  _args: string[],
): Promise<unknown> => [null, null];

const {
  createSingleFlightBeat,
  getDocumentOcrAvailability,
  readDocumentOcrAvailability,
  refreshDocumentOcrWorkerReadiness,
} = await import("@/api/lib/document-processing-readiness");

const createReadinessClient = () => ({ send: readinessSend });

/**
 * The class these pin: the heartbeat's wait is bounded, but a deadline
 * cancels nothing. If the single-flight slot were released when the caller
 * gave up rather than when the work finished, every interval during a broker
 * outage would attach another continuation to the same pending connect, and
 * each one would send its own lease write the moment the socket came back.
 */
describe("readiness heartbeat scheduling", () => {
  /** A beat whose work and caller-visible deadline settle independently. */
  const pendingBeat = () => {
    const state = {
      releaseConnect: (): void => undefined,
      sends: 0,
      starts: 0,
      timeOut: (_error: Error): void => undefined,
    };
    const beat = createSingleFlightBeat(() => {
      state.starts += 1;
      const connected = new Promise<void>((resolve) => {
        state.releaseConnect = resolve;
      });
      const chain = connected.then((): number => {
        state.sends += 1;
        return state.sends;
      });
      const observed = new Promise<never>((_resolve, reject) => {
        state.timeOut = reject;
      });
      // The chain is what holds the slot; `observed` is only the caller's
      // view of it, exactly as `withTimeout` leaves them in production.
      return { chain, observed };
    });
    return { beat, state };
  };

  test("a beat whose caller timed out keeps the slot until its write settles", async () => {
    const { beat, state } = pendingBeat();

    const first = beat.start();
    expect(first).not.toBeNull();
    // The interval gives up after its deadline while the connect is still
    // climbing. Nothing about the underlying write has changed.
    state.timeOut(
      new Error("document OCR readiness heartbeat exceeded 2000ms"),
    );
    // swallow-ok: injected caller timeout precedes assertions that the underlying write retains its slot
    await first?.catch(() => undefined);

    expect(beat.start()).toBeNull();
    expect(state.starts).toBe(1);
    expect(state.sends).toBe(0);

    // The connect comes back: exactly one write, from the one retained beat.
    state.releaseConnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.sends).toBe(1);

    // The work settled, so the next interval beats again.
    const next = beat.start();
    expect(next).not.toBeNull();
    expect(state.starts).toBe(2);
    state.timeOut(new Error("done"));
    // swallow-ok: final drain of the second heartbeat after its start count has been asserted
    await next?.catch(() => undefined);
  });

  test("a beat that is still connecting blocks the next interval", async () => {
    let starts = 0;
    let releaseConnect: () => void = () => undefined;
    const beat = createSingleFlightBeat(() => {
      starts += 1;
      const chain = new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
      return { chain, observed: chain };
    });

    const first = beat.start();
    // Two more intervals fire while the first beat is still connecting.
    expect(first).not.toBeNull();
    expect(beat.start()).toBeNull();
    expect(beat.start()).toBeNull();
    expect(starts).toBe(1);

    releaseConnect();
    await first;

    const fourth = beat.start();
    expect(fourth).not.toBeNull();
    expect(starts).toBe(2);
    releaseConnect();
    await fourth;
  });

  test("a failed beat still releases the next interval", async () => {
    let starts = 0;
    const beat = createSingleFlightBeat(() => {
      starts += 1;
      const chain = Promise.reject(new Error("connect ECONNREFUSED"));
      return { chain, observed: chain };
    });

    // A rejection that left the slot taken would silence the heartbeat for
    // the life of the process, which the lease TTL cannot survive.
    // swallow-ok: injected connection rejection exercises release of the single-flight slot, asserted below
    await beat.start()?.catch(() => undefined);
    // swallow-ok: second injected connection rejection is followed by the next-start count assertion
    await beat.start()?.catch(() => undefined);

    expect(starts).toBe(2);
  });
});

describe("document OCR worker readiness", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  test("configures readiness clients to fail fast during Redis outages", async () => {
    const source = await Bun.file(
      new URL("document-processing-readiness.ts", import.meta.url),
    ).text();

    expect(source).toContain(
      "connectionTimeout: DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS",
    );
    expect(source).toContain("enableOfflineQueue: false");
    // The fail-fast factory is the only place a client is built here, and
    // both long-lived readiness clients are held through the lazy holder:
    // a bare client whose connection closes can never be reopened, so its
    // holder would keep reading a socket that is not coming back.
    expect(source.match(/createRedisClient\(/gu)).toHaveLength(1);
    expect(
      source.match(
        /createLazyRedisClient\(\s*createDocumentOcrReadinessClient,?\s*\)/gu,
      ),
    ).toHaveLength(2);
  });

  test("derives the status from the live lease first, then the batch lease", async () => {
    const statusFor = async (live: string | null, batch: string | null) =>
      (await readDocumentOcrAvailability(async () => ({ live, batch }))).type;
    for (const batch of ["ready", null, "stale"]) {
      expect(await statusFor("ready", batch)).toBe("live");
    }
    for (const live of [null, "stale"]) {
      expect(await statusFor(live, "ready")).toBe("batched");
      expect(await statusFor(live, null)).toBe("unconfigured");
      expect(await statusFor(live, "stale")).toBe("unconfigured");
    }
  });

  test("reads both leases in one MGET on the shared slot", async () => {
    const calls: [string, string[]][] = [];
    readinessSend = async (command, args) => {
      calls.push([command, args]);
      return [null, "ready"];
    };

    expect(await getDocumentOcrAvailability(createReadinessClient)).toEqual({
      type: "batched",
    });
    expect(calls).toEqual([
      [
        "MGET",
        [
          "ocr-readiness:{ocr-worker}:v1",
          "ocr-readiness:{ocr-worker}:batch-v1",
        ],
      ],
    ]);
  });

  test("captures a malformed lease reply and degrades to unconfigured", async () => {
    readinessSend = async () => "ready";

    expect(await getDocumentOcrAvailability(createReadinessClient)).toEqual({
      type: "unconfigured",
    });
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("degrades to unconfigured on a dropped socket without capturing", async () => {
    // The transient and non-transient fixtures must classify differently,
    // or both assertions below would pass through the same branch.
    const transient = Object.assign(new Error("Connection closed"), {
      code: "ERR_REDIS_CONNECTION_CLOSED",
    });
    const defect = Object.assign(new Error("WRONGTYPE"), {
      code: "ERR_REDIS_INVALID_TYPE",
    });
    expect(isTransientRedisConnectionError(transient)).toBe(true);
    expect(isTransientRedisConnectionError(defect)).toBe(false);

    readinessSend = async () => {
      throw transient;
    };
    expect(await getDocumentOcrAvailability(createReadinessClient)).toEqual({
      type: "unconfigured",
    });
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toMatchObject([
      {
        message: "document_processing.readiness_read_disrupted",
        attributes: { "error.type": "Error" },
      },
    ]);

    readinessSend = async () => {
      throw defect;
    };
    expect(await getDocumentOcrAvailability(createReadinessClient)).toEqual({
      type: "unconfigured",
    });
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "Error", "error.code": "ERR_REDIS_INVALID_TYPE" },
    ]);
    // The defect took the capture branch, so no second disruption warning.
    expect(logs.at("WARN")).toHaveLength(1);
  });

  test("bounds readiness reads", async () => {
    const neverResolves = new Promise<string | null>(() => {
      // Deliberately pending to exercise the caller's deadline.
    });

    const rejection: unknown = await readDocumentOcrAvailability(
      async () => ({ live: await neverResolves, batch: null }),
      5,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "document OCR readiness read exceeded 5ms",
    });
  });

  test("publishes a live lease and a batch lease spanning two batch intervals", async () => {
    const calls: [string, string, number][] = [];
    const writeLease = async (
      key: string,
      value: string,
      ttlSeconds: number,
    ) => {
      calls.push([key, value, ttlSeconds]);
      return "OK";
    };

    await refreshDocumentOcrWorkerReadiness({
      writeLease,
      batchIntervalMinutes: 1440,
    });

    expect(calls).toEqual([
      ["ocr-readiness:{ocr-worker}:v1", "ready", 90],
      ["ocr-readiness:{ocr-worker}:batch-v1", "ready", 2 * 1440 * 60],
    ]);
  });

  test("bounds readiness heartbeats", async () => {
    const neverResolves = new Promise<unknown>(() => {
      // Deliberately pending to exercise the caller's deadline.
    });

    const rejection: unknown = await refreshDocumentOcrWorkerReadiness({
      writeLease: async () => await neverResolves,
      batchIntervalMinutes: 1440,
      timeoutMs: 5,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "document OCR readiness heartbeat exceeded 5ms",
    });
  });
});
