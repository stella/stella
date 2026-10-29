import { panic, Result } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";
import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";
import { Temporal } from "@stll/time";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import { detached } from "@/lib/detached";
// Recover from code that a deploy removed. Vite dispatches
// `vite:preloadError` on the window when a lazily imported module fails to
// load — typically a stale chunk after a deploy, or a transient network error.
// Viewers hit the same class when a worker script (PDF.js) cannot load.
//
// Strategy: reload once to fetch the fresh chunk. If another stale load fails
// within a short cooldown, stop reloading and let the error reach an error
// boundary, so a genuinely broken chunk cannot reload-loop. Every caller
// shares the one guard below.

const RELOAD_COOLDOWN_MS = 10_000;
const STORAGE_KEY = "stella:preload-reload-at";
const VERSION_MANIFEST_PATH = "/version.json";
const VERSION_MANIFEST_MAX_BYTES = 1024;
const VERSION_MANIFEST_IDLE_TIMEOUT_MS = 8000;

// Keep this aligned with TanStack Router's cross-browser dynamic-import
// classifier. A rejected lazy import is cached inside lazyRouteComponent, so
// resetting the route boundary can only throw the same error again; recovery
// requires a new page module graph. Vite's preload helper rejects with its
// own message when a chunk's stylesheet is gone. PDF.js reports a worker
// script it cannot load as a failed fake-worker setup.
const STALE_DEPLOYMENT_ERROR_PREFIXES = Object.freeze([
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS for",
  "Setting up fake worker failed",
]);

const isHtmlModuleResponseError = (message: string): boolean =>
  containsSearchMatchKey(message, "module script") &&
  containsSearchMatchKey(message, "MIME type") &&
  containsSearchMatchKey(message, "text/html");

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
    (STALE_DEPLOYMENT_ERROR_PREFIXES.some((prefix) =>
      containsSearchMatchKey(message.slice(0, prefix.length), prefix),
    ) ||
      isHtmlModuleResponseError(message))
  );
};

export type FailedChunkLoadClassification =
  { type: "build-skew" } | { type: "not-skew" };

type StaleDeploymentReloadOutcome =
  | { type: "started" }
  | { type: "refused-cooldown" }
  | { type: "refused-storage" };

type VersionManifest = { commit: string };

const isVersionManifest = (value: unknown): value is VersionManifest =>
  typeof value === "object" &&
  value !== null &&
  "commit" in value &&
  typeof value.commit === "string";

/** A chunk-shaped error is only build skew after the current build is confirmed. */
export const classifyFailedChunkLoad =
  async (): Promise<FailedChunkLoadClassification> => {
    if (!navigator.onLine) {
      return { type: "not-skew" };
    }

    return fetchWithTimeout(VERSION_MANIFEST_PATH, {
      cache: "no-store",
      timeout: { type: "idle", ms: VERSION_MANIFEST_IDLE_TIMEOUT_MS },
    })
      .then(async (response): Promise<FailedChunkLoadClassification> => {
        if (!response.ok || !response.body) {
          return { type: "not-skew" };
        }
        const bytes = await readCappedBytes(
          response.body,
          VERSION_MANIFEST_MAX_BYTES,
        );
        if (bytes === null) {
          return { type: "not-skew" };
        }
        const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!isVersionManifest(manifest)) {
          return { type: "not-skew" };
        }
        return manifest.commit !== __APP_COMMIT_SHA__
          ? { type: "build-skew" }
          : { type: "not-skew" };
      })
      .catch((error: unknown) => {
        error satisfies unknown;
        return { type: "not-skew" };
      });
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
 * cooldown or the guard cannot be recorded. Refusal outcomes tell callers to
 * render their actionable failure state instead of waiting for navigation.
 */
const reloadForStaleDeployment = (): StaleDeploymentReloadOutcome => {
  const last = readReloadAt();
  if (last === null) {
    return { type: "refused-storage" };
  }
  const now = Temporal.Now.instant().epochMilliseconds;
  if (now - last < RELOAD_COOLDOWN_MS) {
    // Already reloaded recently; the chunk is genuinely failing.
    return { type: "refused-cooldown" };
  }
  if (!recordReloadAt(now)) {
    // Could not record the reload, so the guard would never trip.
    return { type: "refused-storage" };
  }
  window.location.reload();
  return { type: "started" };
};

/** Route lazy imports and Vite preload failures share this recovery owner. */
export const recoverFromStaleDeploymentLoad = async (
  error: unknown,
): Promise<FailedChunkLoadClassification | null> => {
  if (!isStaleDeploymentLoadError(error)) {
    return null;
  }
  const classification = await classifyFailedChunkLoad();
  switch (classification.type) {
    case "build-skew":
      return reloadForStaleDeployment().type === "started"
        ? classification
        : { type: "not-skew" };
    case "not-skew":
      return classification;
    default:
      classification satisfies never;
      return panic(
        `Unhandled failed chunk classification: ${String(classification)}`,
      );
  }
};

// Typed as Event: the WindowEventMap augmentation for "vite:preloadError" is
// not guaranteed in scope.
export const installPreloadErrorRecovery = (): void => {
  window.addEventListener("vite:preloadError", (event: Event) => {
    const error = "payload" in event ? event.payload : undefined;
    if (isStaleDeploymentLoadError(error)) {
      const recovery = recoverFromStaleDeploymentLoad(error);
      detached(recovery, "preload-error-recovery.classify");
    }
  });
};
