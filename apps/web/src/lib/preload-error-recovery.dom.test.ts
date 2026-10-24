import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { recoverFromStaleDeploymentLoad } =
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
