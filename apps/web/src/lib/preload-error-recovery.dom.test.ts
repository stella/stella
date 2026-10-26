import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { installPreloadErrorRecovery, recoverFromStaleDeploymentLoad } =
  await import("./preload-error-recovery");

const STALE_CHUNK_ERRORS = [
  new TypeError(
    "Failed to fetch dynamically imported module: https://example.test/chunk.js",
  ),
  new TypeError(
    "error loading dynamically imported module: https://example.test/chunk.js",
  ),
  new TypeError("Importing a module script failed."),
  new TypeError(
    'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
  ),
] as const;

afterEach(() => {
  browserStorage("session")?.clear();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("stale deployment preload recovery", () => {
  test.each(STALE_CHUNK_ERRORS)(
    "reloads once for $message and then lets the error reach the boundary",
    (error) => {
      const reload = spyOn(window.location, "reload").mockImplementation(
        () => undefined,
      );
      try {
        expect(recoverFromStaleDeploymentLoad(error)).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);

        // The second rejection is inside the cooldown. Returning false leaves
        // ownership with the always-loaded route error boundary.
        expect(recoverFromStaleDeploymentLoad(error)).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        reload.mockRestore();
      }
    },
  );
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

  test("a stale runtime chunk reloads once and leaves later failures visible", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );
    // Vite dispatches this cancelable event with the import error as payload.
    const preloadError = () =>
      Object.assign(new Event("vite:preloadError", { cancelable: true }), {
        payload: STALE_CHUNK_ERRORS[0],
      });
    try {
      installPreloadErrorRecovery();
      const first = preloadError();
      window.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);

      const second = preloadError();
      window.dispatchEvent(second);
      expect(second.defaultPrevented).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
    }
  });
});
