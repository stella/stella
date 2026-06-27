// Framework-agnostic layout scheduler — the first piece of the headless editor
// controller (seam-architecture P4). It owns the "when to lay out" policy:
// coalesce a burst of edits into a single layout pass after a short debounce,
// while enforcing a hard latency cap from the first edit. It carries the editor
// state opaquely (generic `TState`), so it has no ProseMirror or React
// dependency; the React adapter wires it to its `runLayoutPipeline`.

import type { LayoutRunReason } from "../layout-engine/layoutInstrumentation";
import {
  mergeDirtyRanges,
  type DirtyRange,
} from "../paged-layout/incrementalMeasure";

export type LayoutRunOptions = {
  dirtyRange?: DirtyRange;
  forceFull?: boolean;
  reason: LayoutRunReason;
};

export type RunLayout<TState> = (
  state: TState,
  options: LayoutRunOptions,
) => void;

// Injected timing primitives so the scheduler is environment-agnostic (browser
// rAF today; a host-provided clock for desktop or deterministic tests). Mirrors
// the FolioHost `schedule` seam.
export type SchedulerClock = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (id: number) => void;
  now: () => number;
};

// The browser implementation of the injected clock. window.setTimeout is typed
// to return a number (vs Node's Timeout); window is referenced only inside these
// methods (call-time), so importing the scheduler in a non-browser host is safe
// — that host passes its own SchedulerClock.
export const browserClock: SchedulerClock = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (id) => window.clearTimeout(id),
  now: () => window.performance.now(),
};

export type LayoutSchedulerConfig<TState> = {
  runLayout: RunLayout<TState>;
  /** Quiet-window debounce before an interactive layout pass. */
  debounceMs: number;
  /** Hard cap on latency from the first edit in a burst. */
  maxDelayMs: number;
  /**
   * Timing source. Pass `browserClock` in the browser; a host injects its own
   * for desktop/headless. Required (no browser default) so the scheduler never
   * silently depends on `window`.
   */
  clock: SchedulerClock;
};

export type LayoutScheduler<TState> = {
  /**
   * Schedule a layout pass after a short coalescing window. Repeated calls in
   * the window replace the pending state and merge dirty ranges, so a typing
   * burst paints once while still honoring the max-latency cap.
   */
  schedule: (state: TState, dirtyRange: DirtyRange | null) => void;
  /** Cancel any pending timer/frame. Call on teardown. */
  dispose: () => void;
};

type PendingLayoutRequest<TState> = {
  dirtyRange: DirtyRange | null;
  firstScheduledAt: number;
  rafId: number | null;
  state: TState;
  timerId: number | null;
};

export const createLayoutScheduler = <TState>(
  config: LayoutSchedulerConfig<TState>,
): LayoutScheduler<TState> => {
  const clock = config.clock;
  let pending: PendingLayoutRequest<TState> | null = null;

  const flushPending = (): void => {
    if (!pending || pending.rafId !== null) {
      return;
    }
    pending.timerId = null;
    pending.rafId = clock.requestFrame(() => {
      const latest = pending;
      pending = null;
      if (!latest) {
        return;
      }
      const options: LayoutRunOptions = { reason: "transaction" };
      if (latest.dirtyRange) {
        options.dirtyRange = latest.dirtyRange;
      }
      config.runLayout(latest.state, options);
    });
  };

  const armTimer = (request: PendingLayoutRequest<TState>): void => {
    if (request.rafId !== null) {
      return;
    }
    if (request.timerId !== null) {
      clock.clearTimer(request.timerId);
    }
    const elapsedMs = clock.now() - request.firstScheduledAt;
    const delayMs =
      elapsedMs >= config.maxDelayMs
        ? 0
        : Math.min(config.debounceMs, config.maxDelayMs - elapsedMs);
    request.timerId = clock.setTimer(flushPending, delayMs);
  };

  return {
    schedule(state, dirtyRange) {
      if (pending) {
        pending.state = state;
        pending.dirtyRange = mergeDirtyRanges(pending.dirtyRange, dirtyRange);
        armTimer(pending);
        return;
      }
      const next: PendingLayoutRequest<TState> = {
        dirtyRange,
        firstScheduledAt: clock.now(),
        rafId: null,
        state,
        timerId: null,
      };
      pending = next;
      armTimer(next);
    },
    dispose() {
      if (!pending) {
        return;
      }
      if (pending.timerId !== null) {
        clock.clearTimer(pending.timerId);
      }
      if (pending.rafId !== null) {
        clock.cancelFrame(pending.rafId);
      }
      pending = null;
    },
  };
};
