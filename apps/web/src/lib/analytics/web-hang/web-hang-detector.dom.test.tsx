import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { Analytics } from "@/lib/analytics/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat/private-id" });
const {
  createWebHangDetector,
  HANG_MARKER_PREFIX,
  MAX_HANG_MARKERS,
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
  session.setItem("stella:web-hang-tab", "test-tab");
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
const markerKeys = () =>
  Array.from({ length: local.length }, (_, index) => local.key(index)).filter(
    (name): name is string => name?.startsWith(HANG_MARKER_PREFIX) === true,
  );

type SetupOptions = {
  random?: () => number;
  now?: () => number;
  browser?: Window & Partial<Pick<typeof globalThis, "PerformanceObserver">>;
};

const setup = ({
  random = () => 1,
  now = () => HANG_STALE_MS + 10,
  browser = window,
}: SetupOptions = {}) => {
  const existingKeys = new Set(markerKeys());
  const hangs: Parameters<Analytics["capturePageHangSuspected"]>[0][] = [];
  const frames: Parameters<Analytics["captureLongAnimationFrame"]>[0][] = [];
  const detector = createWebHangDetector({
    window: browser,
    build: "current",
    now,
    random,
  });
  disposers.push(detector.dispose);
  const markerKey = markerKeys().find((name) => !existingKeys.has(name));

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
  return { detector, hangs, frames, attach, markerKey };
};
test("a stale boot reports once and resets layout before restoration, with a visible recovery toast", async () => {
  seed("boot");
  const { detector, hangs, attach } = setup();
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
  attach();
  expect(hangs).toHaveLength(1);
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
  const { detector, hangs } = setup();
  expect(detector.safeMode).toBe(false);
  expect(local.getItem("stella:inspector-state")).toBe(
    "privileged document content",
  );
  expect(hangs.at(0)?.phase).toBe("session");
  expect(hangs).toHaveLength(1);
});
test("a new tab consumes a stale terminated-tab boot while live tabs remain isolated", () => {
  seed("boot");
  session.clear();
  const recovery = setup();
  expect(recovery.detector.safeMode).toBe(true);
  expect(recovery.hangs.at(0)?.phase).toBe("boot");
  expect(local.getItem(key)).toBeNull();
  session.clear();
  const liveNeighbour = setup();
  expect(liveNeighbour.detector.safeMode).toBe(false);
  expect(liveNeighbour.hangs).toEqual([]);
});
test("duplicated session ids cannot share document markers or erase a neighbor's hang evidence", () => {
  const firstFrame = document.createElement("iframe");
  const secondFrame = document.createElement("iframe");
  document.body.append(firstFrame, secondFrame);
  const firstBrowser = firstFrame.contentWindow;
  const secondBrowser = secondFrame.contentWindow;
  if (!firstBrowser || !secondBrowser) {
    throw new DOMException("Document windows required");
  }
  Object.defineProperty(firstBrowser.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  Object.defineProperty(secondBrowser.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  let clock = 100;
  try {
    session.setItem("stella:web-hang-tab", "copied-tab");
    const first = setup({ browser: firstBrowser, now: () => clock });
    session.setItem("stella:web-hang-tab", "copied-tab");
    const second = setup({ browser: secondBrowser, now: () => clock });
    expect(first.markerKey).toBeDefined();
    expect(second.markerKey).toBeDefined();
    if (first.markerKey === undefined || second.markerKey === undefined) {
      throw new DOMException("Distinct document markers required");
    }
    expect(second.markerKey).not.toBe(first.markerKey);
    expect(markerKeys()).toHaveLength(2);
    secondBrowser.dispatchEvent(new Event("pagehide"));
    expect(markerKeys()).toEqual([first.markerKey]);
    first.detector.dispose();
    clock += HANG_STALE_MS + 1;
    const recovery = setup({ now: () => clock });
    expect(recovery.hangs).toHaveLength(1);
    expect(recovery.hangs.at(0)?.phase).toBe("boot");
    const next = setup({ now: () => clock });
    expect(next.hangs).toEqual([]);
  } finally {
    firstFrame.remove();
    secondFrame.remove();
  }
});
test("document marker retention stays bounded and prunes the oldest entries first", () => {
  seed("session", { heartbeat: 100 });
  const template = local.getItem(key);
  if (template === null) {
    throw new DOMException("Marker fixture required");
  }
  for (let index = 0; index < MAX_HANG_MARKERS + 2; index += 1) {
    local.setItem(
      `${HANG_MARKER_PREFIX}old-${index}`,
      template.replace('"started":1', () => `"started":${index + 2}`),
    );
  }
  const { markerKey } = setup({ now: () => 100 });
  if (markerKey === undefined) {
    throw new DOMException("Document marker required");
  }
  expect(markerKeys()).toHaveLength(MAX_HANG_MARKERS);
  expect(markerKeys()).toContain(markerKey);
  expect(local.getItem(key)).toBeNull();
  expect(local.getItem(`${HANG_MARKER_PREFIX}old-0`)).toBeNull();
  expect(local.getItem(`${HANG_MARKER_PREFIX}old-1`)).toBeNull();
  expect(local.getItem(`${HANG_MARKER_PREFIX}old-2`)).toBeNull();
  expect(local.getItem(`${HANG_MARKER_PREFIX}old-3`)).not.toBeNull();
});
test("a clean pagehide followed by reload emits nothing", () => {
  const first = setup();
  window.dispatchEvent(new Event("pagehide"));
  first.detector.dispose();
  const next = setup();
  expect(next.hangs).toEqual([]);
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
    const { detector, markerKey } = setup();
    if (markerKey === undefined) {
      throw new DOMException("New document marker required");
    }
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
test("a restored page completes boot after its idle callback ran while stopped", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  const idleTasks: (() => void)[] = [];
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (task: () => void) => {
      idleTasks.push(task);
      return idleTasks.length;
    },
  });
  let clock = 100;
  try {
    const { detector, markerKey } = setup({ now: () => clock });
    if (markerKey === undefined) {
      throw new DOMException("Document marker required");
    }
    detector.routeReady("/chat/$threadId");
    expect(idleTasks).toHaveLength(1);
    window.dispatchEvent(new Event("pagehide"));
    expect(local.getItem(markerKey)).toBeNull();
    idleTasks.shift()?.();
    expect(idleTasks).toHaveLength(0);
    expect(local.getItem(markerKey)).toBeNull();
    window.dispatchEvent(new Event("pageshow"));
    expect(local.getItem(markerKey)).toContain('"phase":"boot"');
    expect(idleTasks).toHaveLength(1);
    idleTasks.shift()?.();
    expect(local.getItem(markerKey)).toContain('"phase":"session"');
    detector.dispose();
    clock += HANG_STALE_MS + 1;
    const next = setup({ now: () => clock });
    expect(next.hangs).toHaveLength(1);
    expect(next.hangs.at(0)?.phase).toBe("session");
    expect(next.detector.safeMode).toBe(false);
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
    const { detector, markerKey } = setup();
    if (markerKey === undefined) {
      throw new DOMException("New document marker required");
    }
    expect(local.getItem(markerKey)).toContain('"recovery":true');
    detector.routeReady("/chat/$threadId");
    onIdle?.();
    expect(local.getItem(markerKey)).toBeNull();
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
    const markerKey = markerKeys().at(0);
    if (markerKey === undefined) {
      throw new DOMException("Document marker required");
    }
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
    const { detector, hangs } = setup();
    expect(detector.safeMode).toBe(false);
    expect(hangs).toEqual([]);
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
    const excluded = setup({ random: () => 1 });
    expect(observers).toBe(0);
    excluded.detector.dispose();
    const { frames } = setup({ random: () => 0 });
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
