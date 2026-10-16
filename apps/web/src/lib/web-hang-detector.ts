import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { browserStorage } from "@/lib/account/browser-storage";
import type { Analytics } from "@/lib/analytics/types";
import {
  PERSISTED_UI_STATE_NAMES,
  isPersistedUiStateFingerprintKey,
  persistedUiStateFingerprint,
  resetPersistedUiState,
} from "@/lib/persisted-ui-state";
import { reportWebPageHang } from "@/lib/web-hang-report";
import { resolveWebRouteTemplate } from "@/lib/web-route-template";

export const HANG_HEARTBEAT_MS = 3000;
export const HANG_STALE_MS = 15_000;
export const LOAF_SAMPLE_RATE = 0.1;
export const LOAF_SESSION_LIMIT = 5;
export const HANG_TAB_KEY = "stella:web-hang-tab";
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
type HangAnalytics = Pick<
  Analytics,
  "capturePageHangSuspected" | "captureLongAnimationFrame"
>;

export type HangDetectorOptions = {
  window: Window & Partial<Pick<typeof globalThis, "PerformanceObserver">>;
  build: string;
  now?: () => number;
  random?: () => number;
  report?: (phase: "boot" | "session") => void;
};

type ObserveFramesOptions = {
  browser: HangDetectorOptions["window"];
  sampled: boolean;
  readAnalytics: () => HangAnalytics | undefined;
};

const observeLongAnimationFrames = ({
  browser,
  sampled,
  readAnalytics,
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
          if (
            entry.duration <= 1000 ||
            frames >= LOAF_SESSION_LIMIT ||
            !readAnalytics()
          ) {
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
          readAnalytics()?.captureLongAnimationFrame({
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

/** Storage and browser APIs are optional at this boot boundary. */
export const createWebHangDetector = ({
  window: browser,
  build,
  now = () => Temporal.Now.instant().epochMilliseconds,
  random = Math.random,
  report,
}: HangDetectorOptions) => {
  const local = browserStorage("local");
  const session = browserStorage("session");
  const read = (storage: Storage | null, key: string) =>
    Result.try(() => storage?.getItem(key) ?? null).unwrapOr(null);
  const tab = read(session, HANG_TAB_KEY) ?? browser.crypto.randomUUID();
  const storageReady = Result.try(() => {
    if (!local || !session) {
      return false;
    }
    session.setItem(HANG_TAB_KEY, tab);
    return true;
  }).unwrapOr(false);
  const key = `${HANG_MARKER_PREFIX}${tab}`;
  const markerKeys = storageReady
    ? Result.try(() =>
        Array.from(
          { length: local?.length ?? 0 },
          (_, index) => local?.key(index) ?? null,
        ).filter(
          (name): name is string =>
            name?.startsWith(HANG_MARKER_PREFIX) === true,
        ),
      ).unwrapOr([])
    : [];
  let previous: { key: string; marker: Marker } | undefined;
  for (const candidate of markerKeys) {
    const raw = read(local, candidate);
    const parsed = Result.try((): unknown =>
      raw === null ? null : JSON.parse(raw),
    ).unwrapOr(null);
    const decoded = v.safeParse(markerSchema, parsed);
    if (
      !decoded.success ||
      !decoded.output.visible ||
      now() - decoded.output.heartbeat <= HANG_STALE_MS
    ) {
      continue;
    }
    if (!previous || decoded.output.heartbeat > previous.marker.heartbeat) {
      previous = { key: candidate, marker: decoded.output };
    }
  }
  const prior = previous?.marker ?? null;
  const suspected = prior !== null;
  // A new tab must also recover a stale boot left by a terminated tab.
  // Consuming that record prevents later loads from replaying the report.
  if (previous && previous.key !== key) {
    Result.try(() => local?.removeItem(previous.key));
  }
  const safeMode = suspected && prior.phase === "boot" && !prior.recovery;
  const restoredState = persistedUiStateFingerprint(local);
  if (safeMode) {
    resetPersistedUiState(local);
  }
  let marker: Marker = {
    routeTemplate: resolveWebRouteTemplate(browser.location.pathname),
    started: now(),
    heartbeat: now(),
    phase: "boot",
    build,
    restoredState,
    visible: browser.document.visibilityState === "visible",
    recovery: safeMode,
  };
  let stopped = false;
  let reported = false;
  let notified = false;
  let analytics: HangAnalytics | undefined;
  let idlePending = false;
  const persist = () => {
    if (!storageReady || stopped) {
      return;
    }
    Result.try(() => local?.setItem(key, JSON.stringify(marker)));
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
    Result.try(() => local?.removeItem(key));
  };
  const onShow = () => {
    stopped = false;
    onVisibility();
  };
  persist();
  if (suspected) {
    report?.(prior.phase);
  }
  const timer = browser.setInterval(pulse, HANG_HEARTBEAT_MS);
  browser.document.addEventListener("visibilitychange", onVisibility);
  browser.addEventListener("pagehide", onHide);
  browser.addEventListener("pageshow", onShow);
  const observer = observeLongAnimationFrames({
    browser,
    sampled: random() < LOAF_SAMPLE_RATE,
    readAnalytics: () => analytics,
  });
  return {
    safeMode,
    attach: (options: {
      analytics: HangAnalytics;
      routeTemplates: ReadonlySet<string>;
    }) => {
      analytics = options.analytics;
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
      if (idlePending || marker.phase === "session") {
        return;
      }
      idlePending = true;
      const interactive = () => {
        if (stopped) {
          return;
        }
        marker = { ...marker, phase: "session", heartbeat: now() };
        // Remove the failed-boot record after recovery; subsequent heartbeats
        // describe the healthy session rather than triggering recovery again.
        if (safeMode) {
          Result.try(() => local?.removeItem(key));
        } else {
          persist();
        }
      };
      if (typeof browser.requestIdleCallback === "function") {
        browser.requestIdleCallback(interactive);
      } else {
        browser.requestAnimationFrame(() => {
          browser.setTimeout(interactive, 0);
        });
      }
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
      browser.clearInterval(timer);
      observer?.disconnect();
      browser.document.removeEventListener("visibilitychange", onVisibility);
      browser.removeEventListener("pagehide", onHide);
      browser.removeEventListener("pageshow", onShow);
    },
  };
};

let detector: ReturnType<typeof createWebHangDetector> | undefined;
export const startWebHangDetector = () => {
  detector ??= createWebHangDetector({
    window,
    build: __APP_VERSION__,
    report: (phase) => {
      reportWebPageHang(phase).catch((error: unknown) => {
        reportError(error);
      });
    },
  });
};
export const getWebHangDetector = () => detector;
