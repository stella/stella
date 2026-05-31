/**
 * Tests for the off-main-thread measurement proxy.
 *
 * These tests inject a fake transport so we never spawn a real
 * `Worker` (bun:test runs in a non-DOM environment). The real worker
 * entry is covered separately via `font-metrics.worker.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearAllCaches,
  clearTextWidthCache,
  getCachedTextWidth,
} from "./cache";
import { setFolioMeasurementFlags } from "./featureFlags";
import { measureTextWidth, resetCanvasContext } from "./measureContainer";
import {
  __disposeMeasureProxyForTests,
  __flushMeasureQueueForTests,
  __isMeasureProxyLiveForTests,
  __setMeasureWorkerTransport,
  prefetchMeasurement,
  type MeasureWorkerTransport,
} from "./measureWorker";
import {
  WORKER_FONT_FINGERPRINT_TEXT,
  type MeasureWorkerRequest,
  type MeasureWorkerResponse,
} from "./measureWorkerProtocol";

type FakeTransport = MeasureWorkerTransport & {
  posted: MeasureWorkerRequest[];
  emit: (response: MeasureWorkerResponse) => void;
  emitError: () => void;
  terminated: boolean;
};

function makeFontCacheKey(font: string, horizontalScale: number): string {
  return `${font}|scale:${horizontalScale}`;
}

const TEST_FONT_FINGERPRINT_WIDTH = 123;

function prefetchForTest(
  text: string,
  font: string,
  letterSpacing: number,
  horizontalScale: number,
): void {
  prefetchMeasurement(
    text,
    font,
    letterSpacing,
    horizontalScale,
    makeFontCacheKey(font, horizontalScale),
    TEST_FONT_FINGERPRINT_WIDTH,
  );
}

function makeFakeTransport(options?: { throwOnPost?: boolean }): FakeTransport {
  const messageListeners: ((event: { data: MeasureWorkerResponse }) => void)[] =
    [];
  const errorListeners: ((event: unknown) => void)[] = [];
  const posted: MeasureWorkerRequest[] = [];
  const transport = {
    posted,
    terminated: false,
    postMessage(message: MeasureWorkerRequest): void {
      if (options?.throwOnPost) {
        throw new Error("fake transport: postMessage failed");
      }
      posted.push(message);
    },
    addEventListener(
      type: "message" | "error",
      listener:
        | ((event: { data: MeasureWorkerResponse }) => void)
        | ((event: unknown) => void),
    ): void {
      if (type === "message") {
        messageListeners.push(
          listener as (event: { data: MeasureWorkerResponse }) => void,
        );
      } else {
        errorListeners.push(listener as (event: unknown) => void);
      }
    },
    terminate(): void {
      transport.terminated = true;
    },
    emit(response: MeasureWorkerResponse): void {
      for (const l of messageListeners) {
        l({ data: response });
      }
    },
    emitError(): void {
      for (const l of errorListeners) {
        l(new Error("simulated worker crash"));
      }
    },
  };
  return transport;
}

function installFakeDocument(options?: {
  onMeasureText?: (text: string) => void;
}): void {
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(text: string) {
              options?.onMeasureText?.(text);
              return {
                width: text.length * 7,
                actualBoundingBoxAscent: 8,
                actualBoundingBoxDescent: 2,
              };
            },
          };
        },
      };
    },
  } as unknown as Document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  resetCanvasContext();
}

function uninstallFakeDocument(): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: undefined,
  });
  resetCanvasContext();
}

beforeEach(() => {
  clearAllCaches();
  __disposeMeasureProxyForTests();
  __setMeasureWorkerTransport(null);
  setFolioMeasurementFlags(undefined);
});

afterEach(() => {
  __disposeMeasureProxyForTests();
  __setMeasureWorkerTransport(null);
  setFolioMeasurementFlags(undefined);
  uninstallFakeDocument();
});

describe("prefetchMeasurement (flag gating)", () => {
  test("does nothing when the flag bag is missing", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("hello", "11px Arial", 0, 1);

    expect(__isMeasureProxyLiveForTests()).toBe(false);
    expect(transport.posted).toHaveLength(0);
  });

  test("does nothing when the flag is explicitly false", () => {
    setFolioMeasurementFlags({ workerFontMetrics: false });
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("hello", "11px Arial", 0, 1);

    expect(__isMeasureProxyLiveForTests()).toBe(false);
    expect(transport.posted).toHaveLength(0);
  });

  test("does nothing when the flag is a truthy non-true value", () => {
    // The strict `=== true` check is load-bearing: surface-area protection
    // against accidental string/number injection from URL-driven flag bags.
    setFolioMeasurementFlags({
      workerFontMetrics: "yes" as unknown as boolean,
    });
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("hello", "11px Arial", 0, 1);

    expect(__isMeasureProxyLiveForTests()).toBe(false);
  });

  test("enqueues when the flag is true", () => {
    setFolioMeasurementFlags({ workerFontMetrics: true });
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("hello", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();

    expect(transport.posted).toHaveLength(1);
    expect(transport.posted[0]?.entries).toEqual([
      {
        text: "hello",
        font: "11px Arial",
        fontCacheKey: "11px Arial|scale:1",
        fontFingerprintWidth: TEST_FONT_FINGERPRINT_WIDTH,
        letterSpacing: 0,
        horizontalScale: 1,
      },
    ]);
  });
});

describe("prefetchMeasurement (batching + dedup)", () => {
  beforeEach(() => {
    setFolioMeasurementFlags({ workerFontMetrics: true });
  });

  test("dedupes identical entries inside a single flush", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("hello", "11px Arial", 0, 1);
    prefetchForTest("hello", "11px Arial", 0, 1);
    prefetchForTest("hello", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();

    expect(transport.posted).toHaveLength(1);
    expect(transport.posted[0]?.entries).toHaveLength(1);
  });

  test("does not dedupe entries that differ only by font or letterSpacing", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("hi", "11px Arial", 0, 1);
    prefetchForTest("hi", "12px Arial", 0, 1);
    prefetchForTest("hi", "11px Arial", 0.5, 1);
    __flushMeasureQueueForTests();

    expect(transport.posted[0]?.entries).toHaveLength(3);
  });

  test("ignores empty text", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();

    expect(transport.posted).toHaveLength(0);
  });
});

describe("response handling (cache fills)", () => {
  beforeEach(() => {
    setFolioMeasurementFlags({ workerFontMetrics: true });
  });

  test("writes worker responses into the main-thread cache", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("world", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();

    const id = transport.posted[0]?.id ?? -1;
    transport.emit({
      type: "measure-result",
      id,
      ok: true,
      entries: [
        {
          text: "world",
          fontCacheKey: "11px Arial|scale:1",
          letterSpacing: 0,
          width: 99,
        },
      ],
    });

    expect(getCachedTextWidth("world", "11px Arial|scale:1", 0)).toBe(99);
  });

  test("drops worker responses measured before a text-cache reset", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("stale", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();
    const staleId = transport.posted[0]?.id ?? -1;

    clearTextWidthCache();

    transport.emit({
      type: "measure-result",
      id: staleId,
      ok: true,
      entries: [
        {
          text: "stale",
          fontCacheKey: "11px Arial|scale:1",
          letterSpacing: 0,
          width: 99,
        },
      ],
    });

    expect(getCachedTextWidth("stale", "11px Arial|scale:1", 0)).toBe(
      undefined,
    );

    prefetchForTest("fresh", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();
    transport.emit({
      type: "measure-result",
      id: transport.posted[1]?.id ?? -1,
      ok: true,
      entries: [
        {
          text: "fresh",
          fontCacheKey: "11px Arial|scale:1",
          letterSpacing: 0,
          width: 101,
        },
      ],
    });

    expect(getCachedTextWidth("fresh", "11px Arial|scale:1", 0)).toBe(101);
  });

  test("drops pending entries queued before a text-cache reset", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("stale", "11px Arial", 0, 1);
    clearTextWidthCache();
    __flushMeasureQueueForTests();

    expect(transport.posted).toHaveLength(0);

    prefetchForTest("fresh", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();

    expect(transport.posted).toHaveLength(1);
    expect(transport.posted[0]?.entries[0]?.text).toBe("fresh");
  });

  test("disables the proxy on an ok:false response", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("oops", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();
    transport.emit({
      type: "measure-result",
      id: transport.posted[0]?.id ?? -1,
      ok: false,
      error: "no OffscreenCanvas",
    });

    expect(transport.terminated).toBe(true);
    expect(__isMeasureProxyLiveForTests()).toBe(false);
  });

  test("disables the proxy on a transport error event", () => {
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("oops", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();
    transport.emitError();

    expect(transport.terminated).toBe(true);
    expect(__isMeasureProxyLiveForTests()).toBe(false);
  });

  test("disables the proxy when postMessage throws", () => {
    const transport = makeFakeTransport({ throwOnPost: true });
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("boom", "11px Arial", 0, 1);
    __flushMeasureQueueForTests();

    expect(__isMeasureProxyLiveForTests()).toBe(false);
  });
});

describe("integration with measureTextWidth", () => {
  test("measureTextWidth still returns identical values when the flag is OFF", () => {
    const measuredTexts: string[] = [];
    installFakeDocument({
      onMeasureText: (text) => {
        measuredTexts.push(text);
      },
    });
    const baseline = measureTextWidth("hello", { fontFamily: "Arial" });
    expect(baseline).toBeGreaterThan(0);

    // With the flag off, no worker is spawned regardless of cache state.
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);
    clearAllCaches();

    const again = measureTextWidth("hello", { fontFamily: "Arial" });
    expect(again).toBe(baseline);
    expect(transport.posted).toHaveLength(0);
    expect(measuredTexts).not.toContain(WORKER_FONT_FINGERPRINT_TEXT);
  });

  test("measureTextWidth pre-warms the worker on cache miss when the flag is ON", () => {
    installFakeDocument();
    setFolioMeasurementFlags({ workerFontMetrics: true });
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    const value = measureTextWidth("hello", { fontFamily: "Arial" });
    __flushMeasureQueueForTests();

    expect(value).toBeGreaterThan(0);
    expect(transport.posted).toHaveLength(1);
    const entry = transport.posted[0]?.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    expect(entry.text).toBe("hello");
    expect(entry.font).not.toContain("|scale:");
    expect(entry.fontCacheKey).toBe(`${entry.font}|scale:1`);
  });

  test("measureTextWidth cache hit does not enqueue (no main-thread cost, no worker cost)", () => {
    installFakeDocument();
    setFolioMeasurementFlags({ workerFontMetrics: true });
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    // Prime the cache by routing through the real entrypoint, then
    // flush the resulting pre-warm and clear the recorded posts.
    const primed = measureTextWidth("seed", {
      fontFamily: "Arial",
      fontSize: 9,
    });
    __flushMeasureQueueForTests();
    expect(transport.posted.length).toBeGreaterThan(0);
    transport.posted.length = 0;

    // Second call with identical signature must hit the cache without
    // re-enqueuing — that is the contract that keeps the worker off
    // the critical path for repeated runs.
    const again = measureTextWidth("seed", {
      fontFamily: "Arial",
      fontSize: 9,
    });
    __flushMeasureQueueForTests();

    expect(again).toBe(primed);
    expect(transport.posted).toHaveLength(0);
  });
});

describe("worker fallback (no OffscreenCanvas)", () => {
  test("when neither Worker nor injected factory is present, proxy stays dead and main thread answers", () => {
    installFakeDocument();
    setFolioMeasurementFlags({ workerFontMetrics: true });
    // No injected factory and the bun environment has no Worker —
    // ensureProxy() should bail and main-thread canvas handles
    // everything.
    __setMeasureWorkerTransport(null);

    const value = measureTextWidth("fallback", { fontFamily: "Arial" });

    expect(value).toBeGreaterThan(0);
    expect(__isMeasureProxyLiveForTests()).toBe(false);
  });

  test("worker-filled cache and main-thread cache are byte-identical for the same key", () => {
    // The proxy writes via setCachedTextWidth using exactly the same
    // key the main-thread path uses. We verify that the cache reads
    // back the same value the worker reported, byte-for-byte, so a
    // future main-thread measurement returns the worker's number.
    setFolioMeasurementFlags({ workerFontMetrics: true });
    const transport = makeFakeTransport();
    __setMeasureWorkerTransport(() => transport);

    prefetchForTest("xyz", "13px Calibri", 1.5, 1);
    __flushMeasureQueueForTests();
    transport.emit({
      type: "measure-result",
      id: transport.posted[0]?.id ?? -1,
      ok: true,
      entries: [
        {
          text: "xyz",
          fontCacheKey: "13px Calibri|scale:1",
          letterSpacing: 1.5,
          width: 42.5,
        },
      ],
    });

    expect(getCachedTextWidth("xyz", "13px Calibri|scale:1", 1.5)).toBe(42.5);
  });
});
