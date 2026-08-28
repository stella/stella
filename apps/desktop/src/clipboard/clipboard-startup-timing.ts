import {
  DESKTOP_TELEMETRY_SPANS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopTiming,
} from "../telemetry/desktop-telemetry";
import type { DesktopTelemetrySpan } from "../telemetry/desktop-telemetry";
import type { ClipboardSnapshot } from "./clipboard-types";

// Each span is reported once per page load. Guards live at module level so
// StrictMode double effects and hot reloads cannot duplicate a measurement.
const reported = new Set<DesktopTelemetrySpan>();

const claim = (span: DesktopTelemetrySpan) => {
  if (reported.has(span)) {
    return false;
  }
  reported.add(span);
  return true;
};

const reportSinceNavigation = (span: DesktopTelemetrySpan) => {
  reportDesktopTiming({
    durationMs: performance.now(),
    span,
    window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
  });
};

export const markClipboardShellCommit = () => {
  if (claim(DESKTOP_TELEMETRY_SPANS.clipboardShellCommit)) {
    reportSinceNavigation(DESKTOP_TELEMETRY_SPANS.clipboardShellCommit);
  }
};

/** Measures the round trip of the first snapshot request only. */
export const measureClipboardSnapshotRequest = async <T>(
  request: Promise<T>,
): Promise<T> => {
  if (!claim(DESKTOP_TELEMETRY_SPANS.clipboardSnapshotRequest)) {
    return request;
  }
  const started = performance.now();
  try {
    return await request;
  } finally {
    reportDesktopTiming({
      durationMs: performance.now() - started,
      span: DESKTOP_TELEMETRY_SPANS.clipboardSnapshotRequest,
      window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
    });
  }
};

const afterNextPaint = (callback: () => void) => {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
};

/**
 * Reports the delay users feel on Cmd+Shift+V with a running app: the hidden
 * window regaining focus until the next painted frame. On macOS WebKit a
 * window hide/show does not flip page visibility, but it does refire window
 * focus. The first focus belongs to the initial open, which first paint
 * already covers, so it is skipped.
 */
export const observeClipboardReopens = () => {
  let seenFirstFocus = false;
  const onFocus = () => {
    if (!seenFirstFocus) {
      seenFirstFocus = true;
      return;
    }
    const shown = performance.now();
    afterNextPaint(() => {
      reportDesktopTiming({
        durationMs: performance.now() - shown,
        span: DESKTOP_TELEMETRY_SPANS.clipboardReopenPaint,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
      });
    });
  };
  window.addEventListener("focus", onFocus);
  return () => {
    window.removeEventListener("focus", onFocus);
  };
};

/**
 * Call after React committed a snapshot. First paint is the frame after the
 * first applied snapshot; history ready is the first snapshot whose
 * persistence has settled, which can arrive later when initialization was
 * still running at the first read.
 */
export const markClipboardSnapshotApplied = (snapshot: ClipboardSnapshot) => {
  if (claim(DESKTOP_TELEMETRY_SPANS.clipboardFirstPaint)) {
    afterNextPaint(() => {
      reportSinceNavigation(DESKTOP_TELEMETRY_SPANS.clipboardFirstPaint);
    });
  }
  if (
    snapshot.persistence.status !== "initializing" &&
    claim(DESKTOP_TELEMETRY_SPANS.clipboardHistoryReady)
  ) {
    reportSinceNavigation(DESKTOP_TELEMETRY_SPANS.clipboardHistoryReady);
  }
};
