import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://app.example.test/chat" });
const { bootClientRuntime } = await import("./client-bootstrap");
const { getWebHangDetector } = await import("./web-hang-detector");
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

test("a browser without randomUUID loads its runtime and starts fallback detection", async () => {
  const previous = Object.getOwnPropertyDescriptor(window.crypto, "randomUUID");
  Object.defineProperty(window.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  expect(globalThis.crypto.randomUUID).toBeUndefined();
  const captured: unknown[] = [];
  let loaded = 0;
  await bootClientRuntime({
    loadRuntime: async () => {
      loaded += 1;
    },
    captureDetectorError: (error) => {
      captured.push(error);
    },
  });
  expect(loaded).toBe(1);
  expect(captured).toEqual([]);
  expect(getWebHangDetector()).toBeDefined();
  if (previous === undefined) {
    Reflect.deleteProperty(window.crypto, "randomUUID");
  } else {
    Object.defineProperty(window.crypto, "randomUUID", previous);
  }
});
