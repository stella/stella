/**
 * Main-thread proxy for the off-main-thread font-measurement worker.
 *
 * Lifecycle:
 *   1. Caller enqueues a request via `prefetchMeasurement`.
 *   2. The proxy debounces and batches enqueued requests on a ~10 ms
 *      tick, deduping by cache key.
 *   3. The flushed batch is posted to the worker.
 *   4. The worker replies with widths; the proxy writes them into the
 *      main-thread LRU cache via `setCachedTextWidth`.
 *
 * The proxy is **never** on the critical path. `measureTextWidth` on
 * the main thread always returns synchronously from either the cache or
 * a direct canvas read. The worker only pre-warms entries so subsequent
 * re-layout passes (font-ready, page-resize, suggestion-mode toggles)
 * hit the cache instead of the main-thread canvas.
 *
 * Gating:
 *   - `isWorkerFontMetricsEnabled()` is checked on every enqueue. If
 *     the flag is OFF, the function is a no-op and no worker is ever
 *     constructed.
 *   - `OffscreenCanvas` and `Worker` are feature-detected at first
 *     enqueue. Missing either disables the proxy for the session.
 *   - Any worker construction or message-port error disables the proxy
 *     for the session; subsequent enqueues are no-ops.
 *
 * Tests inject a fake transport via `__setMeasureWorkerTransport`. In
 * production the transport is `null` and the real `Worker` is
 * constructed on demand.
 */

import { getTextWidthCacheGeneration, setCachedTextWidth } from "./cache";
import { isWorkerFontMetricsEnabled } from "./featureFlags";
import type {
  MeasureRequestEntry,
  MeasureWorkerRequest,
  MeasureWorkerResponse,
} from "./measureWorkerProtocol";

// =============================================================================
// TRANSPORT
// =============================================================================

/**
 * Minimal duck-typed transport so tests can supply a fake instead of a
 * real `Worker`. Mirrors the subset of `Worker` we use.
 */
export type MeasureWorkerTransport = {
  postMessage(message: MeasureWorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: { data: MeasureWorkerResponse }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  terminate(): void;
};

type TransportFactory = () => MeasureWorkerTransport;

let injectedTransportFactory: TransportFactory | null = null;

/**
 * Test-only: inject a transport factory in place of the real `Worker`
 * constructor. Pass `null` to restore production behaviour.
 */
export function __setMeasureWorkerTransport(
  factory: TransportFactory | null,
): void {
  injectedTransportFactory = factory;
  // Reset state so the next enqueue picks up the new factory.
  disposeProxy();
  isDead = false;
}

// =============================================================================
// FEATURE DETECTION
// =============================================================================

/**
 * True when the host environment exposes both `Worker` and
 * `OffscreenCanvas`. Older Safari, jsdom, SSR, and bun:test (without a
 * DOM shim) all return `false` and route to the main-thread fallback.
 *
 * Detection is intentionally cheap and re-runnable — tests reset
 * globals between cases.
 */
function isWorkerMeasurementSupported(): boolean {
  if (injectedTransportFactory !== null) {
    return true;
  }
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof URL !== "undefined"
  );
}

// =============================================================================
// PROXY STATE
// =============================================================================

type ProxyState = {
  transport: MeasureWorkerTransport;
  pending: Map<string, MeasureRequestEntry>;
  inFlightGenerations: Map<number, number>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  nextRequestId: number;
  dead: boolean;
};

let state: ProxyState | null = null;
let isDead = false;

/**
 * Dispose any live worker, reset queue. Idempotent. Called when the
 * worker reports an unrecoverable error or when tests swap transports.
 */
function disposeProxy(unrecoverable = false): void {
  if (state === null) {
    if (unrecoverable) {
      isDead = true;
    }
    return;
  }
  state.dead = true;
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
  }
  try {
    state.transport.terminate();
  } catch {
    // Worker may already be dead; nothing useful to do.
  }
  state = null;
  if (unrecoverable) {
    isDead = true;
  }
}

function makeKey(
  text: string,
  fontCacheKey: string,
  letterSpacing: number,
): string {
  return `${text}|${fontCacheKey}|${letterSpacing}`;
}

function createTransport(): MeasureWorkerTransport | null {
  if (injectedTransportFactory !== null) {
    try {
      return injectedTransportFactory();
    } catch {
      return null;
    }
  }
  try {
    // Vite-compatible worker construction. The bundler resolves the
    // URL at build time. We cast to the transport shape so this file
    // does not depend on the global `Worker` type at module load.
    const worker = new Worker(
      new URL("font-metrics.worker.ts", import.meta.url),
      { type: "module" },
    );
    return worker as unknown as MeasureWorkerTransport;
  } catch {
    return null;
  }
}

function ensureProxy(): ProxyState | null {
  if (isDead) {
    return null;
  }
  if (state !== null) {
    return state.dead ? null : state;
  }
  if (!isWorkerMeasurementSupported()) {
    isDead = true;
    return null;
  }
  const transport = createTransport();
  if (transport === null) {
    isDead = true;
    return null;
  }
  const next: ProxyState = {
    transport,
    pending: new Map(),
    inFlightGenerations: new Map(),
    flushTimer: null,
    nextRequestId: 0,
    dead: false,
  };
  transport.addEventListener("message", (event) => {
    handleResponse(next, event.data);
  });
  transport.addEventListener("error", () => {
    // Hard error: drop the proxy. Nothing in-flight needs explicit
    // rejection — the main thread already filled the cache directly
    // before we ever enqueued.
    disposeProxy(true);
  });
  state = next;
  return state;
}

// =============================================================================
// BATCHING
// =============================================================================

/**
 * How long to wait before flushing the queue, in milliseconds. Short
 * enough to keep the worker warm and ahead of the binary-search probes,
 * long enough to amortise `postMessage` overhead across a typical
 * paragraph's worth of probes.
 */
const FLUSH_INTERVAL_MS = 10;

/**
 * Cap on entries per round trip. Prevents one runaway paragraph (think
 * an unbroken 200 KB CDATA dump from a paste) from monopolising a
 * single message. Excess entries flush on the next tick.
 */
const MAX_BATCH_SIZE = 256;

function scheduleFlush(current: ProxyState): void {
  if (current.flushTimer !== null) {
    return;
  }
  current.flushTimer = setTimeout(() => {
    current.flushTimer = null;
    flush(current);
  }, FLUSH_INTERVAL_MS);
}

function flush(current: ProxyState): void {
  if (current.pending.size === 0 || current.dead) {
    return;
  }
  // Drain up to MAX_BATCH_SIZE entries; reschedule for any leftovers.
  const entries: MeasureRequestEntry[] = [];
  for (const entry of current.pending.values()) {
    entries.push(entry);
    if (entries.length >= MAX_BATCH_SIZE) {
      break;
    }
  }
  for (const entry of entries) {
    current.pending.delete(
      makeKey(entry.text, entry.fontCacheKey, entry.letterSpacing),
    );
  }
  const id = current.nextRequestId;
  current.nextRequestId += 1;
  current.inFlightGenerations.set(id, getTextWidthCacheGeneration());
  try {
    // The unicorn `targetOrigin` lint targets `window.postMessage`;
    // `Worker.postMessage` does not accept that argument.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    current.transport.postMessage({ type: "measure", id, entries });
  } catch {
    current.inFlightGenerations.delete(id);
    disposeProxy(true);
    return;
  }
  if (current.pending.size > 0) {
    scheduleFlush(current);
  }
}

function handleResponse(
  current: ProxyState,
  message: MeasureWorkerResponse,
): void {
  if (state !== current || current.dead) {
    return;
  }
  const requestGeneration = current.inFlightGenerations.get(message.id);
  current.inFlightGenerations.delete(message.id);
  if (requestGeneration === undefined) {
    return;
  }
  if (!message.ok) {
    // Worker self-diagnosed an unrecoverable problem. Disable for the
    // session — main thread continues to handle everything.
    disposeProxy(true);
    return;
  }
  if (requestGeneration !== getTextWidthCacheGeneration()) {
    return;
  }
  for (const entry of message.entries) {
    setCachedTextWidth(
      entry.text,
      entry.fontCacheKey,
      entry.letterSpacing,
      entry.width,
    );
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Enqueue a measurement for asynchronous pre-warming. Returns
 * immediately. The caller has already filled the cache synchronously
 * for the *current* probe; this prefetch is only useful for *future*
 * probes (re-layouts triggered by font-ready, page-resize, or
 * suggestion-mode toggles, which all re-measure the same runs).
 *
 * No-op when the feature flag is OFF, when the host lacks
 * `OffscreenCanvas`/`Worker`, or when the proxy has been disabled by
 * a previous error.
 */
export function prefetchMeasurement(
  text: string,
  font: string,
  letterSpacing: number,
  horizontalScale: number,
  fontCacheKey: string,
): void {
  if (!isWorkerFontMetricsEnabled()) {
    return;
  }
  if (!text) {
    return;
  }
  const current = ensureProxy();
  if (current === null) {
    return;
  }
  const key = makeKey(text, fontCacheKey, letterSpacing);
  if (current.pending.has(key)) {
    return;
  }
  current.pending.set(key, {
    text,
    font,
    fontCacheKey,
    letterSpacing,
    horizontalScale,
  });
  scheduleFlush(current);
}

/**
 * Test-only: synchronously drain the pending queue. The caller is
 * expected to have already attached its assertions to the cache or to
 * the injected transport.
 */
export function __flushMeasureQueueForTests(): void {
  if (state === null) {
    return;
  }
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  flush(state);
}

/**
 * Test-only: dispose the proxy. Safe to call when nothing is live.
 */
export function __disposeMeasureProxyForTests(): void {
  disposeProxy();
  isDead = false;
}

/**
 * Test-only: report whether the proxy considers itself alive. Useful
 * for asserting that flag/feature-detection gating actually short-
 * circuits worker construction.
 */
export function __isMeasureProxyLiveForTests(): boolean {
  return state !== null && !state.dead;
}
