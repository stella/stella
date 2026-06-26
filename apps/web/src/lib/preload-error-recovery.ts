// Recover from a failed dynamic route-chunk import. Vite dispatches
// `vite:preloadError` on the window when a lazily imported module fails to
// load — typically a stale chunk after a deploy, or a dev HMR / dep-reoptimize
// race. Left unhandled this blanks the screen mid-navigation, before the
// router's error boundary can render.
//
// Strategy: reload once to fetch the fresh chunk. If another preload fails
// within a short cooldown, stop reloading and let the error bubble to the
// router error boundary, so a genuinely broken chunk cannot reload-loop.

const RELOAD_COOLDOWN_MS = 10_000;
const STORAGE_KEY = "stella:preload-reload-at";

// The single-reload guard relies on sessionStorage persisting across the
// reload. sessionStorage can throw (private mode, sandboxed iframe, storage
// disabled), so both access points are guarded: if we cannot read or record
// the timestamp we skip the reload entirely and fall through to the error
// boundary, rather than risk a reload loop with no working guard.
const readReloadAt = (): number | null => {
  try {
    return Number(window.sessionStorage.getItem(STORAGE_KEY) ?? "0");
  } catch {
    return null;
  }
};

const recordReloadAt = (timestamp: number): boolean => {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(timestamp));
    return true;
  } catch {
    return false;
  }
};

// Typed as Event: the WindowEventMap augmentation for "vite:preloadError" is
// not guaranteed in scope, and we only need preventDefault() + the reload.
export const installPreloadErrorRecovery = (): void => {
  window.addEventListener("vite:preloadError", (event: Event) => {
    const last = readReloadAt();
    if (last === null) {
      // No durable storage to enforce the single-reload guard; let the router
      // error boundary handle it instead of risking a reload loop.
      return;
    }
    const now = Date.now();
    if (now - last < RELOAD_COOLDOWN_MS) {
      // Already reloaded recently; the chunk is genuinely failing. Let the
      // error boundary take over instead of looping.
      return;
    }
    if (!recordReloadAt(now)) {
      // Could not record the reload, so the guard would never trip. Skip the
      // reload to avoid looping.
      return;
    }
    // Cancel Vite's default rethrow; we recover by reloading for a fresh chunk.
    event.preventDefault();
    window.location.reload();
  });
};
