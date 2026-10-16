import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { installPreloadErrorRecovery } =
  await import("./preload-error-recovery");
const { deviceStorage } = await import("./account/browser-storage");
const reload = spyOn(window.location, "reload").mockImplementation(
  () => undefined,
);
const storage = deviceStorage("session");
const reloadKey = "stella:preload-reload-at";
installPreloadErrorRecovery();

beforeEach(() => {
  storage.removeItem(reloadKey);
  reload.mockClear();
});

afterAll(async () => {
  reload.mockRestore();
  await unregisterDomEnvironment();
});

describe("preload recovery before runtime import", () => {
  test("entry installs the listener before requesting its runtime chunk", async () => {
    const entry = await Bun.file(
      new URL("../client.tsx", import.meta.url),
    ).text();
    const runtime = await Bun.file(
      new URL("../client-runtime.tsx", import.meta.url),
    ).text();
    const installation = entry.indexOf("installPreloadErrorRecovery();");
    expect(installation).toBeGreaterThan(-1);
    expect(installation).toBeLessThan(
      entry.indexOf('import("@/client-runtime")'),
    );
    expect(runtime).not.toContain("installPreloadErrorRecovery");
  });

  test("a rejected runtime import reloads once and leaves subsequent failures visible", async () => {
    // Vite dispatches this cancelable event when its wrapped dynamic import rejects.
    const failedImport = await import(
      new URL("missing-runtime-chunk.js", import.meta.url).href
    ).then(
      () => ({ status: "loaded" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    expect(failedImport.status).toBe("failed");
    const first = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(storage.getItem(reloadKey))).toBeGreaterThan(0);

    const second = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
