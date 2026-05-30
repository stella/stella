/**
 * Feature flags for the measurement subsystem.
 *
 * Flags are read from `globalThis.__folioFeatureFlags`. This mirrors the
 * existing `__folioLayoutInstrumentation` pattern: callers from `apps/web`
 * (or any host app) install the bag before mounting `DocxEditor`, and the
 * measurement code reads it on demand without taking a hard dependency on
 * any host framework.
 *
 * All flags default OFF so that callers who never set the bag see exactly
 * the same behaviour as before any of this code existed.
 */

/**
 * Flag bag shape. Adding a new flag means adding a key here and a `get*Flag`
 * accessor below.
 */
export type FolioMeasurementFeatureFlags = {
  /**
   * Pre-warm the text-width cache from a Web Worker so cache misses during
   * the line-break binary search become cache hits on subsequent probes.
   *
   * When OFF (default), no worker is ever created and every measurement
   * runs on the main thread exactly as before.
   */
  workerFontMetrics?: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __folioFeatureFlags: FolioMeasurementFeatureFlags | undefined;
}

/**
 * Read the worker-font-metrics flag. Returns `false` if the bag is missing,
 * the key is unset, or the value is anything other than `true`. The strict
 * comparison ensures truthy-but-not-true values (strings, numbers) cannot
 * accidentally enable the worker path.
 */
export function isWorkerFontMetricsEnabled(): boolean {
  return globalThis.__folioFeatureFlags?.workerFontMetrics === true;
}

/**
 * Test-only helper to set the flag bag without polluting host state.
 * Production callers should set `globalThis.__folioFeatureFlags` directly.
 */
export function setFolioMeasurementFlags(
  flags: FolioMeasurementFeatureFlags | undefined,
): void {
  globalThis.__folioFeatureFlags = flags;
}
