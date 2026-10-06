import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
// Recover from code that a deploy removed. Vite dispatches
// `vite:preloadError` on the window when a lazily imported module fails to
// load — typically a stale chunk after a deploy, or a dev HMR / dep-reoptimize
// race. Left unhandled this blanks the screen mid-navigation, before the
// router's error boundary can render. Viewers hit the same class when a
// worker script (PDF.js) from the previous build is gone.
//
// Strategy: reload once to fetch the fresh chunk. If another stale load fails
// within a short cooldown, stop reloading and let the error reach an error
// boundary, so a genuinely broken chunk cannot reload-loop. Every caller
// shares the one guard below.

const RELOAD_COOLDOWN_MS = 10_000;
const STORAGE_KEY = "stella:preload-reload-at";

// Keep this aligned with TanStack Router's cross-browser dynamic-import
// classifier. A rejected lazy import is cached inside lazyRouteComponent, so
// resetting the route boundary can only throw the same error again; recovery
// requires a new page module graph. PDF.js reports a worker script it cannot
// load as a failed fake-worker setup.
const STALE_DEPLOYMENT_ERROR_PREFIXES = Object.freeze([
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Setting up fake worker failed",
]);

const getErrorMessage = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }
  const { message } = error;
  return typeof message === "string" ? message : undefined;
};

export const isStaleDeploymentLoadError = (error: unknown): boolean => {
  const message = getErrorMessage(error);
  return (
    message !== undefined &&
    STALE_DEPLOYMENT_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
};

// The single-reload guard relies on sessionStorage persisting across the
// reload. sessionStorage can throw (private mode, sandboxed iframe, storage
// disabled), so both access points are guarded: if we cannot read or record
// the timestamp we skip the reload entirely and fall through to the error
// boundary, rather than risk a reload loop with no working guard.
const readReloadAt = (): number | null =>
  requireBrowserStorage("session")
    .andThen((storage) =>
      Result.try(() => Number(storage.getItem(STORAGE_KEY) ?? "0")),
    )
    .unwrapOr(null);

const recordReloadAt = (timestamp: number): boolean =>
  requireBrowserStorage("session")
    .andThen((storage) =>
      Result.try(() => {
        storage.setItem(STORAGE_KEY, String(timestamp));
        return true;
      }),
    )
    .unwrapOr(false);

/**
 * Reload the page for a fresh build unless one was attempted within the
 * cooldown or the guard cannot be recorded. Returns whether a reload started;
 * `false` means the caller shows its own failure state.
 */
export const reloadForStaleDeployment = (): boolean => {
  const last = readReloadAt();
  if (last === null) {
    return false;
  }
  const now = Temporal.Now.instant().epochMilliseconds;
  if (now - last < RELOAD_COOLDOWN_MS) {
    // Already reloaded recently; the chunk is genuinely failing.
    return false;
  }
  if (!recordReloadAt(now)) {
    // Could not record the reload, so the guard would never trip.
    return false;
  }
  window.location.reload();
  return true;
};

// Typed as Event: the WindowEventMap augmentation for "vite:preloadError" is
// not guaranteed in scope, and we only need preventDefault() + the reload.
export const installPreloadErrorRecovery = (): void => {
  window.addEventListener("vite:preloadError", (event: Event) => {
    if (reloadForStaleDeployment()) {
      // Cancel Vite's default rethrow; the reload fetches the fresh chunk.
      event.preventDefault();
    }
  });
};
