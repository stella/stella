import { panic, Result } from "better-result";

import { sleep } from "@stll/concurrency/sleep";
import { fetchWithTimeout } from "@stll/fetch";
import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";
import { Temporal } from "@stll/time";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import { detached } from "@/lib/detached";
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
const VERSION_MANIFEST_PATH = "/version.json";
const INITIAL_RUNTIME_RETRY_DELAYS_MS = [250, 1000] as const;

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
  { type: "offline" } | { type: "network-error" } | { type: "build-skew" };

export type StaleDeploymentReloadOutcome =
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
      return { type: "offline" };
    }

    return fetchWithTimeout(VERSION_MANIFEST_PATH, {
      cache: "no-store",
      timeoutMs: 8000,
    })
      .then(async (response): Promise<FailedChunkLoadClassification> => {
        if (!response.ok) {
          return { type: "network-error" };
        }
        const manifest: unknown = await response.json();
        if (!isVersionManifest(manifest)) {
          return { type: "network-error" };
        }
        return manifest.commit !== __APP_COMMIT_SHA__
          ? { type: "build-skew" }
          : { type: "network-error" };
      })
      .catch((error: unknown) => {
        error satisfies unknown;
        return { type: "network-error" };
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
export const reloadForStaleDeployment = (): StaleDeploymentReloadOutcome => {
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

export type FailedChunkRecovery =
  | { type: "reload"; outcome: StaleDeploymentReloadOutcome }
  | { type: "retry-when-online" }
  | { type: "retry-now" };

export type FailedChunkRecoveryDecision = {
  classification: FailedChunkLoadClassification;
  recovery: FailedChunkRecovery;
};

type InitialRuntimeLoadOutcome = { type: "loaded" } | { type: "reloading" };

type InitialRuntimeLoadOptions = {
  load: () => Promise<unknown>;
  retryDelaysMs?: readonly number[] | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  waitUntilOnline?: (() => Promise<void>) | undefined;
};

const waitForOnline = async (): Promise<void> =>
  new Promise((resolve) => {
    window.addEventListener("online", () => resolve(), { once: true });
  });

/**
 * Load the entry runtime through a finite recovery state machine. Offline
 * startup waits for the one signal that can make progress; online transport
 * failures retry with bounded backoff and then reject to the startup error UI.
 */
export const loadInitialRuntimeWithRecovery = async ({
  load,
  retryDelaysMs = INITIAL_RUNTIME_RETRY_DELAYS_MS,
  wait = sleep,
  waitUntilOnline = waitForOnline,
}: InitialRuntimeLoadOptions): Promise<InitialRuntimeLoadOutcome> => {
  let retryAttempt = 0;
  let retriedAfterOffline = false;
  for (;;) {
    const result = await Result.tryPromise(load);
    if (result.isOk()) {
      return { type: "loaded" };
    }
    const loadError = result.error.cause;
    if (!isStaleDeploymentLoadError(loadError)) {
      throw loadError;
    }

    const classification = await classifyFailedChunkLoad();
    switch (classification.type) {
      case "build-skew": {
        const reload = reloadForStaleDeployment();
        switch (reload.type) {
          case "started":
            return { type: "reloading" };
          case "refused-cooldown":
          case "refused-storage":
            throw loadError;
          default:
            reload satisfies never;
            return panic(`Unhandled reload outcome: ${String(reload)}`);
        }
      }
      case "offline":
        if (retriedAfterOffline) {
          throw loadError;
        }
        retriedAfterOffline = true;
        await waitUntilOnline();
        break;
      case "network-error": {
        const delayMs = retryDelaysMs.at(retryAttempt);
        if (delayMs === undefined) {
          throw loadError;
        }
        retryAttempt += 1;
        await wait(delayMs);
        break;
      }
      default:
        classification satisfies never;
        return panic(
          `Unhandled failed chunk classification: ${String(classification)}`,
        );
    }
  }
};

/** Route lazy imports and Vite preload failures share this recovery owner. */
export const recoverFromStaleDeploymentLoad = async (
  error: unknown,
  retry: () => void,
): Promise<FailedChunkRecoveryDecision | null> => {
  if (!isStaleDeploymentLoadError(error)) {
    return null;
  }
  const classification = await classifyFailedChunkLoad();
  switch (classification.type) {
    case "build-skew":
      return {
        classification,
        recovery: { type: "reload", outcome: reloadForStaleDeployment() },
      };
    case "offline":
      window.addEventListener("online", retry, { once: true });
      return { classification, recovery: { type: "retry-when-online" } };
    case "network-error":
      retry();
      return { classification, recovery: { type: "retry-now" } };
    default:
      classification satisfies never;
      return panic(
        `Unhandled failed chunk classification: ${String(classification)}`,
      );
  }
};

// Typed as Event: the WindowEventMap augmentation for "vite:preloadError" is
// not guaranteed in scope, and we only need preventDefault() + the reload.
export const installPreloadErrorRecovery = (): void => {
  window.addEventListener("vite:preloadError", (event: Event) => {
    const error = "payload" in event ? event.payload : undefined;
    if (isStaleDeploymentLoadError(error)) {
      // Keep the current document while the asynchronous probe decides whether
      // this is transport failure or confirmed build skew.
      event.preventDefault();
      detached(
        recoverFromStaleDeploymentLoad(error, () => undefined),
        "preload-error-recovery.classify",
      );
    }
  });
};
