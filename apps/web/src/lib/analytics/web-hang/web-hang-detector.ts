import { Result } from "better-result";
import * as v from "valibot";

import { createDetached } from "@stll/errors";
import { Temporal } from "@stll/time";

import { browserStorage } from "@/lib/account/browser-storage";
import type { Analytics } from "@/lib/analytics/types";
import {
  isPersistedUiStateFingerprintKey,
  PERSISTED_UI_STATE_NAMES,
  persistedUiStateFingerprint,
  resetPersistedUiState,
} from "@/lib/analytics/web-hang/persisted-ui-state";
import { resolveWebRouteTemplate } from "@/lib/analytics/web-hang/web-route-template";
import { createEphemeralId } from "@/lib/uuid";

export const HANG_HEARTBEAT_MS = 3000;
export const HANG_STALE_MS = 15_000;
const LOAF_SAMPLE_RATE = 0.1;
export const LOAF_SESSION_LIMIT = 5;
export const MAX_HANG_MARKERS = 32;
export const HANG_MARKER_PREFIX = "stella:web-hang:";

const markerSchema = v.strictObject({
  routeTemplate: v.string(),
  started: v.number(),
  heartbeat: v.number(),
  phase: v.picklist(["boot", "session"]),
  build: v.string(),
  restoredState: v.pipe(
    v.array(
      v.strictObject({
        key: v.string(),
        bytes: v.pipe(v.number(), v.safeInteger()),
      }),
    ),
    v.maxLength(PERSISTED_UI_STATE_NAMES.length),
  ),
  visible: v.boolean(),
  recovery: v.boolean(),
});
type Marker = v.InferOutput<typeof markerSchema>;
const readHangMarkers = (storage: Storage | null) =>
  Result.try(() => {
    if (storage === null) {
      return [];
    }
    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    ).filter(
      (key): key is string => key?.startsWith(HANG_MARKER_PREFIX) === true,
    );
    return keys.map((key) => {
      const raw = storage.getItem(key);
      const parsed = Result.try((): unknown =>
        raw === null ? null : JSON.parse(raw),
      ).unwrapOr(null);
      const decoded = v.safeParse(markerSchema, parsed);
      return { key, marker: decoded.success ? decoded.output : null };
    });
  }).unwrapOr([]);

type WriteHangMarkerOptions = {
  storage: Storage | null;
  key: string;
  marker: Marker;
};

const writeHangMarker = ({ storage, key, marker }: WriteHangMarkerOptions) =>
  Result.try(() => {
    if (storage === null) {
      return false;
    }
    storage.setItem(key, JSON.stringify(marker));
    const records = readHangMarkers(storage);
    const excess = records.length - MAX_HANG_MARKERS;
    if (excess <= 0) {
      return true;
    }
    const oldest = records
      .filter((record) => record.key !== key)
      .toSorted(
        (left, right) =>
          (left.marker?.started ?? 0) - (right.marker?.started ?? 0),
      )
      .slice(0, excess);
    for (const record of oldest) {
      storage.removeItem(record.key);
    }
    return true;
  }).unwrapOr(false);

type HangAnalytics = Pick<
  Analytics,
  "capturePageHangSuspected" | "captureLongAnimationFrame"
>;

export type HangDetectorOptions = {
  window: Window & Partial<Pick<typeof globalThis, "PerformanceObserver">>;
  build: string;
  now?: () => number;
  random?: () => number;
  /**
   * Document liveness: the browser releases a document's lock when the
   * document is destroyed, while a hung document keeps holding it. `null`
   * means the browser has no Locks API.
   */
  locks?: HangLocks | null;
};

type LockNames = readonly { name?: string }[];
/** The part of the Web Locks API this detector uses; LockManager satisfies it. */
export type HangLocks = {
  request: (name: string, granted: () => Promise<void>) => Promise<unknown>;
  query: () => Promise<{ held?: LockNames; pending?: LockNames }>;
};

type ObserveFramesOptions = {
  browser: HangDetectorOptions["window"];
  sampled: boolean;
  captureFrame: HangAnalytics["captureLongAnimationFrame"];
};

const observeLongAnimationFrames = ({
  browser,
  sampled,
  captureFrame,
}: ObserveFramesOptions) => {
  let frames = 0;
  const Observer = browser.PerformanceObserver;
  // Sampling is chosen once per tab load, independently of frame duration.
  if (
    sampled &&
    Observer?.supportedEntryTypes.includes("long-animation-frame")
  ) {
    const observed = Result.try(() => {
      const instance = new Observer((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration <= 1000 || frames >= LOAF_SESSION_LIMIT) {
            continue;
          }
          const frame = v.safeParse(
            v.object({
              scripts: v.array(
                v.object({
                  invoker: v.optional(v.string(), ""),
                  sourceURL: v.optional(v.string(), ""),
                  sourceFunctionName: v.optional(v.string(), ""),
                }),
              ),
            }),
            entry,
          );
          frames += 1;
          captureFrame({
            duration: entry.duration,
            scripts: frame.success ? frame.output.scripts : [],
          });
        }
      });
      instance.observe({ type: "long-animation-frame", buffered: true });
      return instance;
    });
    return observed.unwrapOr(undefined);
  }
  return undefined;
};

type FrameReport = Parameters<HangAnalytics["captureLongAnimationFrame"]>[0];

/**
 * Frames seen before analytics attaches (runtime initialization runs first)
 * wait here and are delivered once on attachment. The observer's session
 * limit bounds the queue.
 */
const createFrameRelay = () => {
  let target: HangAnalytics | undefined;
  const pending: FrameReport[] = [];
  return {
    capture: (frame: FrameReport) => {
      if (target === undefined) {
        pending.push(frame);
        return;
      }
      target.captureLongAnimationFrame(frame);
    },
    attach: (analytics: HangAnalytics) => {
      target = analytics;
      for (const frame of pending.splice(0)) {
        analytics.captureLongAnimationFrame(frame);
      }
    },
    clear: () => {
      pending.length = 0;
    },
  };
};

/**
 * Reads the markers other documents left: visible boots that started earlier
 * (retired later if they prove abandoned) and the most recent stale visible
 * marker, which is the evidence of a stalled earlier load.
 */
const scanEarlierDocuments = (storage: Storage | null, started: number) => {
  const bootCandidates: BootCandidate[] = [];
  let previous: { key: string; marker: Marker } | undefined;
  for (const { key: candidate, marker: stored } of readHangMarkers(storage)) {
    if (
      stored?.phase === "boot" &&
      stored.visible &&
      stored.started < started
    ) {
      bootCandidates.push({ key: candidate, heartbeat: stored.heartbeat });
    }
    if (
      !stored ||
      !stored.visible ||
      started - stored.heartbeat <= HANG_STALE_MS
    ) {
      continue;
    }
    if (!previous || stored.heartbeat > previous.marker.heartbeat) {
      previous = { key: candidate, marker: stored };
    }
  }
  return { bootCandidates, previous };
};

/** Storage and browser APIs are optional at this boot boundary. */
export const createWebHangDetector = ({
  window: browser,
  build,
  now = () => Temporal.Now.instant().epochMilliseconds,
  random = Math.random,
  locks = "locks" in browser.navigator ? browser.navigator.locks : null,
}: HangDetectorOptions) => {
  const local = browserStorage("local");
  // sessionStorage is copied by duplicate/opener tabs: identity belongs to
  // this document, so another document can never erase its evidence.
  const key = `${HANG_MARKER_PREFIX}${createEphemeralId()}`;
  // Requested before the marker is written, so every marker another document
  // can read is backed by a held or pending lock while this document lives.
  const liveness = createLivenessLock(locks, key);
  liveness.acquire();
  const started = now();
  const { bootCandidates, previous } = scanEarlierDocuments(local, started);
  const prior = previous?.marker ?? null;
  const recovery = prior?.phase === "boot" && !prior.recovery;
  const restoredState = persistedUiStateFingerprint(local);
  let marker: Marker = {
    routeTemplate: resolveWebRouteTemplate(browser.location.pathname),
    started,
    heartbeat: started,
    phase: "boot",
    build,
    restoredState,
    visible: browser.document.visibilityState === "visible",
    recovery,
  };
  const storageReady = writeHangMarker({ storage: local, key, marker });
  const suspected = storageReady && prior !== null;
  const safeMode = storageReady && recovery;
  if (suspected && previous) {
    Result.try(() => local?.removeItem(previous.key)).unwrapOr(undefined);
  }
  if (safeMode) {
    resetPersistedUiState(local);
  }
  let stopped = false;
  let reported = false;
  let notified = false;
  const frameRelay = createFrameRelay();
  let readiness: "routing" | "idle_pending" | "paused" | "interactive" =
    "routing";
  let retirementTimer: ReturnType<typeof browser.setTimeout> | undefined;
  const persist = () => {
    if (!storageReady || stopped) {
      return;
    }
    writeHangMarker({ storage: local, key, marker });
  };
  const pulse = () => {
    if (browser.document.visibilityState !== "visible") {
      return;
    }
    marker = { ...marker, heartbeat: now() };
    persist();
  };
  const onVisibility = () => {
    marker = {
      ...marker,
      visible: browser.document.visibilityState === "visible",
      heartbeat: now(),
    };
    persist();
  };
  const onHide = () => {
    stopped = true;
    Result.try(() => local?.removeItem(key)).unwrapOr(undefined);
    liveness.release();
  };
  const scheduleInteractive = () => {
    if (readiness === "idle_pending" || readiness === "interactive") {
      return;
    }
    readiness = "idle_pending";
    const interactive = () => {
      if (stopped) {
        readiness = "paused";
        return;
      }
      if (readiness === "interactive") {
        return;
      }
      readiness = "interactive";
      marker = { ...marker, phase: "session", heartbeat: now() };
      // Remove the failed-boot record after recovery; subsequent heartbeats
      // describe the healthy session rather than triggering recovery again.
      if (safeMode) {
        Result.try(() => local?.removeItem(key)).unwrapOr(undefined);
      } else {
        persist();
      }
      const retireBootCandidates = async () =>
        retireAbandonedBootCandidates({
          storage: local,
          locks,
          candidates: bootCandidates,
          started: marker.started,
          stopped: () => stopped,
        });
      const retirementDelay = Math.max(
        0,
        started + 2 * HANG_HEARTBEAT_MS - now(),
      );
      retirementTimer = browser.setTimeout(
        retireBootCandidates,
        retirementDelay,
      );
    };
    if (typeof browser.requestIdleCallback === "function") {
      browser.requestIdleCallback(interactive);
    } else {
      browser.requestAnimationFrame(() => {
        browser.setTimeout(interactive, 0);
      });
    }
  };
  const onShow = () => {
    stopped = false;
    liveness.acquire();
    onVisibility();
    if (readiness === "paused") {
      scheduleInteractive();
    }
  };
  let timer: ReturnType<typeof browser.setInterval> | undefined;
  let observer: ReturnType<typeof observeLongAnimationFrames> = undefined;
  const uninstall = () => {
    if (timer !== undefined) {
      browser.clearInterval(timer);
    }
    if (retirementTimer !== undefined) {
      browser.clearTimeout(retirementTimer);
    }
    observer?.disconnect();
    liveness.release();
    browser.document.removeEventListener("visibilitychange", onVisibility);
    browser.removeEventListener("pagehide", onHide);
    browser.removeEventListener("pageshow", onShow);
  };
  const installed = Result.try(() => {
    timer = browser.setInterval(pulse, HANG_HEARTBEAT_MS);
    browser.document.addEventListener("visibilitychange", onVisibility);
    browser.addEventListener("pagehide", onHide);
    browser.addEventListener("pageshow", onShow);
    observer = observeLongAnimationFrames({
      browser,
      sampled: random() < LOAF_SAMPLE_RATE,
      captureFrame: frameRelay.capture,
    });
  });
  if (Result.isError(installed)) {
    // Without its heartbeat and pagehide cleanup this document's boot marker
    // could only ever read as a hung boot later, so it goes with the rest.
    stopped = true;
    uninstall();
    Result.try(() => local?.removeItem(key)).unwrapOr(undefined);
    throw installed.error.cause;
  }
  return {
    safeMode,
    attach: (options: {
      analytics: HangAnalytics;
      routeTemplates: ReadonlySet<string>;
    }) => {
      frameRelay.attach(options.analytics);
      if (!suspected || reported) {
        return;
      }
      reported = true;
      // localStorage is untrusted. Never forward a resolved URL or arbitrary key.
      options.analytics.capturePageHangSuspected({
        routeTemplate: options.routeTemplates.has(prior.routeTemplate)
          ? prior.routeTemplate
          : "unknown",
        phase: prior.phase,
        build: /^[\w.+-]{1,80}$/u.test(prior.build) ? prior.build : "unknown",
        restoredState: prior.restoredState.filter(
          ({ key: name, bytes }) =>
            isPersistedUiStateFingerprintKey(name) &&
            Number.isSafeInteger(bytes) &&
            bytes >= 0,
        ),
      });
    },
    routeReady: (routeTemplate: string) => {
      marker = { ...marker, routeTemplate };
      persist();
      scheduleInteractive();
    },
    notifyRecovery: (notify: () => void) => {
      if (!safeMode || notified) {
        return;
      }
      notified = true;
      notify();
    },
    dispose: () => {
      stopped = true;
      uninstall();
      frameRelay.clear();
    },
  };
};

// Boot runs before analytics attach, so a refused request has nowhere to be
// reported. The document then just lacks a liveness signal: neighbours see no
// held lock and treat its marker as they did before liveness existed.
const detachedLockRequest = createDetached(() => undefined);

/**
 * The document's liveness lock, held while its marker exists. pagehide
 * releases it with the marker: a page holding a Web Lock is not eligible for
 * the back/forward cache, and a hung page cannot run pagehide anyway.
 */
const createLivenessLock = (locks: HangLocks | null, key: string) => {
  let releaseHeld: (() => void) | undefined;
  return {
    acquire: () => {
      if (!locks || releaseHeld) {
        return;
      }
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      detachedLockRequest(
        locks.request(key, async () => held),
        "web-hang.liveness",
      );
    },
    release: () => {
      releaseHeld?.();
      releaseHeld = undefined;
    },
  };
};

type BootCandidate = { key: string; heartbeat: number };
type RetireBootCandidatesOptions = {
  storage: Storage | null;
  locks: HangLocks | null;
  candidates: BootCandidate[];
  started: number;
  stopped: () => boolean;
};

/**
 * A silent heartbeat looks the same for a destroyed document and a hung one,
 * so only a released liveness lock proves a boot was abandoned. Without the
 * Locks API nothing is retired: the evidence waits until a later load reads it.
 */
const retireAbandonedBootCandidates = async ({
  storage,
  locks,
  candidates,
  started,
  stopped,
}: RetireBootCandidatesOptions) => {
  if (!locks || stopped()) {
    return;
  }
  const snapshot = await Result.tryPromise(async () => locks.query());
  if (Result.isError(snapshot) || stopped()) {
    return;
  }
  // A snapshot without both lists cannot prove a document is gone, so
  // nothing is retired on it.
  const { held, pending } = snapshot.value;
  if (!held || !pending) {
    return;
  }
  const live = new Set([...held, ...pending].map((lock) => lock.name));
  const records = new Map(
    readHangMarkers(storage).map((record) => [record.key, record.marker]),
  );
  for (const candidate of candidates) {
    const current = records.get(candidate.key);
    if (
      !live.has(candidate.key) &&
      current?.phase === "boot" &&
      current.visible &&
      current.started < started &&
      current.heartbeat === candidate.heartbeat
    ) {
      Result.try(() => storage?.removeItem(candidate.key)).unwrapOr(undefined);
    }
  }
};

let detector: ReturnType<typeof createWebHangDetector> | undefined;
export const startWebHangDetector = () =>
  Result.try(() => {
    detector ??= createWebHangDetector({
      window,
      build: __APP_VERSION__,
    });
    return detector;
  });
export const getWebHangDetector = () => detector;
