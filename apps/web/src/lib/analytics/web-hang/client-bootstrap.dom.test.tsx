import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://app.example.test/chat" });
const { bootClientRuntime } = await import("./client-bootstrap");
const {
  createWebHangDetector,
  getWebHangDetector,
  HANG_MARKER_PREFIX,
  HANG_STALE_MS,
} = await import("./web-hang-detector");
const { browserStorage } = await import("@/lib/account/browser-storage");
const local = browserStorage("local");
const hangMarkerKeys = () =>
  Array.from({ length: local?.length ?? 0 }, (_, index) =>
    local?.key(index),
  ).filter((name) => name?.startsWith(HANG_MARKER_PREFIX) === true);
const previousBuild = Object.getOwnPropertyDescriptor(
  globalThis,
  "__APP_VERSION__",
);
Object.defineProperty(globalThis, "__APP_VERSION__", {
  configurable: true,
  value: "test",
});

afterAll(async () => {
  getWebHangDetector()?.dispose();
  if (previousBuild === undefined) {
    Reflect.deleteProperty(globalThis, "__APP_VERSION__");
  } else {
    Object.defineProperty(globalThis, "__APP_VERSION__", previousBuild);
  }
  await unregisterDomEnvironment();
});

test("a detector timer failure still loads the runtime before reporting the error", async () => {
  const failure = new DOMException("Timer creation blocked", "SecurityError");
  const timer = spyOn(window, "setInterval").mockImplementation(() => {
    throw failure;
  });
  const runtime = Promise.withResolvers<undefined>();
  const events: string[] = [];
  const captured: unknown[] = [];
  const boot = bootClientRuntime({
    loadRuntime: async () => {
      events.push("runtime requested");
      return runtime.promise;
    },
    captureDetectorError: (error) => {
      events.push("detector reported");
      captured.push(error);
    },
  });
  expect(events).toEqual(["runtime requested"]);
  runtime.resolve(undefined);
  await boot;
  expect(events).toEqual(["runtime requested", "detector reported"]);
  expect(captured).toHaveLength(1);
  expect(captured.at(0)).toMatchObject({ cause: failure });
  expect(getWebHangDetector()).toBeUndefined();
  timer.mockRestore();

  // The failed start leaves no boot evidence, so a later document neither
  // enters recovery nor reports a hang.
  expect(hangMarkerKeys()).toEqual([]);
  const reports: unknown[] = [];
  const later = createWebHangDetector({
    window,
    build: "test",
    now: () => Date.now() + HANG_STALE_MS * 2,
    random: () => 1,
  });
  later.attach({
    analytics: {
      capturePageHangSuspected: (properties) => {
        reports.push(properties);
      },
      captureLongAnimationFrame: () => undefined,
    },
    routeTemplates: new Set(),
  });
  expect(later.safeMode).toBe(false);
  expect(reports).toEqual([]);
  later.dispose();
});
