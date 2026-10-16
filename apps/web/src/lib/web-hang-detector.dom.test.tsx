import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { Analytics } from "@/lib/analytics/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat/private-id" });
const {
  createWebHangDetector,
  HANG_MARKER_PREFIX,
  HANG_TAB_KEY,
  HANG_STALE_MS,
  HANG_HEARTBEAT_MS,
  LOAF_SESSION_LIMIT,
} = await import("./web-hang-detector");
const { render, cleanup } = await import("@testing-library/react");
const { ToastProvider } = await import("@stll/ui/toast");
const { WebHangRecoveryNotice } =
  await import("@/components/web-hang-recovery-notice");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { browserStorage } = await import("@/lib/account/browser-storage");
const local = browserStorage("local");
const session = browserStorage("session");
if (!local || !session) {
  throw new DOMException("DOM storage required");
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  cleanup();
  local.clear();
  session.clear();
});
afterAll(unregisterDomEnvironment);
const key = `${HANG_MARKER_PREFIX}test-tab`;
const seed = (phase: "boot" | "session", overrides = {}) => {
  session.setItem(HANG_TAB_KEY, "test-tab");
  local.setItem("stella:inspector-state", "privileged document content");
  local.setItem(
    key,
    JSON.stringify({
      routeTemplate: "/chat/$threadId",
      started: 1,
      heartbeat: 1,
      phase,
      build: "1.2.3",
      visible: true,
      recovery: false,
      restoredState: [{ key: "stella:inspector-state", bytes: 27 }],
      ...overrides,
    }),
  );
};
const setup = (random = () => 1) => {
  const hangs: Parameters<Analytics["capturePageHangSuspected"]>[0][] = [];
  const frames: Parameters<Analytics["captureLongAnimationFrame"]>[0][] = [];
  const requests: string[] = [];
  const detector = createWebHangDetector({
    window,
    build: "current",
    now: () => HANG_STALE_MS + 10,
    random,
    report: (phase) => {
      requests.push(phase);
    },
  });
  disposers.push(detector.dispose);
  const attach = () =>
    detector.attach({
      analytics: {
        capturePageHangSuspected: (event) => {
          hangs.push(event);
        },
        captureLongAnimationFrame: (event) => {
          frames.push(event);
        },
      },
      routeTemplates: new Set(["/chat/$threadId"]),
    });
  attach();
  return { detector, hangs, frames, requests, attach };
};
test("a stale boot reports once and resets layout before restoration, with a visible recovery toast", async () => {
  seed("boot");
  const { detector, hangs, requests, attach } = setup();
  expect(detector.safeMode).toBe(true);
  expect(local.getItem("stella:inspector-state")).toBeNull();
  expect(hangs).toEqual([
    {
      routeTemplate: "/chat/$threadId",
      phase: "boot",
      build: "1.2.3",
      restoredState: [{ key: "stella:inspector-state", bytes: 27 }],
    },
  ]);
  expect(requests).toEqual(["boot"]);
  attach();
  expect(requests).toHaveLength(1);
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <ToastProvider>
        <WebHangRecoveryNotice detector={detector} />
      </ToastProvider>
    </IntlProvider>,
  );
  expect(
    await view.findByText(messages.common.layoutResetAfterProblem),
  ).toBeTruthy();
  expect(JSON.stringify(hangs)).not.toContain("privileged");
});
test("a stale session reports without resetting layout", () => {
  seed("session");
  const { detector, hangs, requests } = setup();
  expect(detector.safeMode).toBe(false);
  expect(local.getItem("stella:inspector-state")).toBe(
    "privileged document content",
  );
  expect(hangs.at(0)?.phase).toBe("session");
  expect(requests).toEqual(["session"]);
});
test("a new tab consumes a stale terminated-tab boot while live tabs remain isolated", () => {
  seed("boot");
  session.clear();
  const recovery = setup();
  expect(recovery.detector.safeMode).toBe(true);
  expect(recovery.requests).toEqual(["boot"]);
  expect(local.getItem(key)).toBeNull();
  session.clear();
  const liveNeighbour = setup();
  expect(liveNeighbour.detector.safeMode).toBe(false);
  expect(liveNeighbour.requests).toEqual([]);
});
test("a clean pagehide followed by reload emits nothing", () => {
  const first = setup();
  window.dispatchEvent(new Event("pagehide"));
  first.detector.dispose();
  const next = setup();
  expect(next.hangs).toEqual([]);
  expect(next.requests).toEqual([]);
});
test("boot markers contain a template immediately and complete only after router ready and idle", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  let onIdle: (() => void) | undefined;
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (task: () => void) => {
      onIdle = task;
      return 1;
    },
  });
  try {
    const { detector } = setup();
    const tab = session.getItem(HANG_TAB_KEY);
    if (tab === null) {
      throw new DOMException("Tab marker required");
    }
    const markerKey = `${HANG_MARKER_PREFIX}${tab}`;
    expect(local.getItem(markerKey)).toContain(
      '"routeTemplate":"/chat/$threadId"',
    );
    expect(local.getItem(markerKey)).not.toContain("private-id");
    expect(local.getItem(markerKey)).toContain('"phase":"boot"');
    expect(onIdle).toBeUndefined();
    detector.routeReady("/chat/$threadId");
    expect(local.getItem(markerKey)).toContain('"phase":"boot"');
    expect(onIdle).toBeDefined();
    onIdle?.();
    expect(local.getItem(markerKey)).toContain('"phase":"session"');
  } finally {
    if (descriptor) {
      Object.defineProperty(window, "requestIdleCallback", descriptor);
    } else {
      Reflect.deleteProperty(window, "requestIdleCallback");
    }
  }
});
test("a successful safe boot clears its marker before monitoring the healthy session", () => {
  seed("boot");
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  let onIdle: (() => void) | undefined;
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (task: () => void) => {
      onIdle = task;
      return 1;
    },
  });
  try {
    const { detector } = setup();
    expect(local.getItem(key)).toContain('"recovery":true');
    detector.routeReady("/chat/$threadId");
    onIdle?.();
    expect(local.getItem(key)).toBeNull();
  } finally {
    if (descriptor) {
      Object.defineProperty(window, "requestIdleCallback", descriptor);
    } else {
      Reflect.deleteProperty(window, "requestIdleCallback");
    }
  }
});
test("heartbeats run every three seconds only while visible and refresh on visibility changes", () => {
  const intervalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "setInterval",
  );
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  let onHeartbeat: (() => void) | undefined;
  let delay: number | undefined;
  let clock = 100;
  let visibility = "visible";
  Object.defineProperty(window, "setInterval", {
    configurable: true,
    value: (task: () => void, ms: number) => {
      onHeartbeat = task;
      delay = ms;
      return 1;
    },
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const detector = createWebHangDetector({
    window,
    build: "current",
    now: () => clock,
    random: () => 1,
  });
  try {
    const tab = session.getItem(HANG_TAB_KEY);
    if (tab === null) {
      throw new DOMException("Tab marker required");
    }
    const markerKey = `${HANG_MARKER_PREFIX}${tab}`;
    expect(delay).toBe(HANG_HEARTBEAT_MS);
    clock = 200;
    onHeartbeat?.();
    expect(local.getItem(markerKey)).toContain('"heartbeat":200');
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    clock = 300;
    onHeartbeat?.();
    expect(local.getItem(markerKey)).toContain('"heartbeat":200');
    expect(local.getItem(markerKey)).toContain('"visible":false');
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(local.getItem(markerKey)).toContain('"heartbeat":300');
  } finally {
    detector.dispose();
    if (intervalDescriptor) {
      Object.defineProperty(window, "setInterval", intervalDescriptor);
    }
    if (visibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  }
});
test("hidden, recent, and already recovering boots do not reset layout", () => {
  for (const overrides of [
    { visible: false },
    { heartbeat: HANG_STALE_MS },
    { recovery: true },
  ]) {
    seed("boot", overrides);
    const { detector } = setup();
    expect(detector.safeMode).toBe(false);
    expect(local.getItem("stella:inspector-state")).not.toBeNull();
    detector.dispose();
  }
});
test("private-mode storage exceptions leave boot running without reports", () => {
  seed("boot");
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
  });
  try {
    const { detector, hangs, requests } = setup();
    expect(detector.safeMode).toBe(false);
    expect(hangs).toEqual([]);
    expect(requests).toEqual([]);
  } finally {
    if (descriptor) {
      Object.defineProperty(window, "localStorage", descriptor);
    }
  }
});
test("only slow frames from sampled sessions are reported up to the session cap", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "PerformanceObserver",
  );
  let onFrames: PerformanceObserverCallback | undefined;
  let observers = 0;
  class FrameObserver {
    static supportedEntryTypes = ["long-animation-frame"];
    constructor(onEntries: PerformanceObserverCallback) {
      onFrames = onEntries;
      observers += 1;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  Object.defineProperty(window, "PerformanceObserver", {
    configurable: true,
    value: FrameObserver,
  });
  try {
    const excluded = setup(() => 1);
    expect(observers).toBe(0);
    excluded.detector.dispose();
    const { frames } = setup(() => 0);
    expect(observers).toBe(1);
    const entries = [
      999,
      1000,
      ...Array.from({ length: LOAF_SESSION_LIMIT + 2 }, () => 1001),
    ].map((duration) => ({
      duration,
      entryType: "long-animation-frame",
      name: "frame",
      startTime: 1,
      toJSON: () => ({}),
    }));
    onFrames?.(
      {
        getEntries: () => entries,
        getEntriesByName: () => entries,
        getEntriesByType: () => entries,
      },
      new PerformanceObserver(() => {}),
    );
    expect(frames).toHaveLength(LOAF_SESSION_LIMIT);
    expect(frames.every(({ duration }) => duration > 1000)).toBe(true);
  } finally {
    if (descriptor) {
      Object.defineProperty(window, "PerformanceObserver", descriptor);
    } else {
      Reflect.deleteProperty(window, "PerformanceObserver");
    }
  }
});
