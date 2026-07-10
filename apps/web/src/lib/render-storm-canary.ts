// Pure windowing logic for the dev-only render-storm canary
// (@/components/render-storm-canary). Kept separate from the React
// component and its console.error emitter so the decision logic is
// unit-testable without a DOM or React renderer.

export type RenderStormPhase = "mount" | "nested-update" | "update";

export type RenderStormPhaseCounts = Record<RenderStormPhase, number>;

export const createEmptyPhaseCounts = (): RenderStormPhaseCounts => ({
  mount: 0,
  "nested-update": 0,
  update: 0,
});

// React's own "Maximum update depth exceeded" throw only fires once a loop
// hits its hard recursion limit; a *damped* near-loop (a component that
// keeps re-triggering its own update without ever quite reaching that limit)
// re-renders hundreds of times per second and ships silently. This canary
// exists to turn that class of bug into a CI-failing console.error via the
// e2e browserErrors fixture.
//
// Calibration: chat response streaming legitimately commits ~20 times/sec
// (SSE chunks land roughly every 50ms and each chunk is its own commit).
// A damped render loop commits at least in the hundreds/sec range, so 80
// commits/sec sustained across two consecutive 1s windows sits ~4x above
// real streaming traffic (comfortable headroom against jitter/GC pauses)
// while staying well below the loop floor.
export const RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND = 80;

// Window length the commit counter buckets into. Windows are commit-driven
// (closed by the next commit once this much time has elapsed since the
// window opened), not a timer, so a storm is detected without needing an
// effect or interval — see createRenderStormMonitor below.
export const RENDER_STORM_WINDOW_MS = 1000;

// A single over-threshold window can be a legitimate burst (e.g. a big
// paginated list mounting). Two consecutive over-threshold windows is what
// distinguishes a *sustained* storm from a one-off burst.
export const RENDER_STORM_SUSTAINED_WINDOWS_REQUIRED = 2;

// The canary itself must not spam the console once a storm is underway:
// one console.error per storm episode, then at most one more per this
// interval for as long as the storm continues.
export const RENDER_STORM_ERROR_RATE_LIMIT_MS = 10_000;

export type StormWindowResult = {
  consecutiveStormWindows: number;
  isStorm: boolean;
};

/**
 * Decide whether the window that just closed continues, starts, or resets a
 * storm streak, and whether the streak has now become a reportable storm
 * (two consecutive over-threshold windows). Pure and side-effect free so it
 * can be unit-tested without a Profiler or a DOM.
 */
export const evaluateStormWindow = (
  commitsInWindow: number,
  threshold: number,
  previousConsecutiveStormWindows: number,
): StormWindowResult => {
  const isOverThreshold = commitsInWindow > threshold;
  const consecutiveStormWindows = isOverThreshold
    ? previousConsecutiveStormWindows + 1
    : 0;

  return {
    consecutiveStormWindows,
    isStorm: consecutiveStormWindows >= RENDER_STORM_SUSTAINED_WINDOWS_REQUIRED,
  };
};

export type RenderStormDetails = {
  commitsPerSecond: number;
  phaseCounts: RenderStormPhaseCounts;
};

export type RenderStormOnRender = (
  id: string,
  phase: RenderStormPhase,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
) => void;

export type RenderStormMonitor = {
  onRender: RenderStormOnRender;
};

/**
 * Stateful driver around evaluateStormWindow: buckets Profiler commits into
 * commit-driven 1s windows, tracks the phase breakdown of the window that
 * triggered a storm, and rate-limits `emitStorm` to one call per storm
 * episode (then at most one per RENDER_STORM_ERROR_RATE_LIMIT_MS while the
 * storm persists).
 */
export const createRenderStormMonitor = (
  emitStorm: (details: RenderStormDetails) => void,
): RenderStormMonitor => {
  let windowStart: number | undefined;
  let commitsInWindow = 0;
  let phaseCountsInWindow = createEmptyPhaseCounts();
  let consecutiveStormWindows = 0;
  // -Infinity, not 0: a real commitTime of 0 is possible (performance.now()
  // at app start), and seeding this at 0 would suppress the very first
  // storm for RENDER_STORM_ERROR_RATE_LIMIT_MS after boot instead of
  // reporting it immediately.
  let lastErrorEmittedAt = Number.NEGATIVE_INFINITY;

  const closeWindow = (now: number) => {
    const result = evaluateStormWindow(
      commitsInWindow,
      RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND,
      consecutiveStormWindows,
    );
    consecutiveStormWindows = result.consecutiveStormWindows;

    const canEmit =
      now - lastErrorEmittedAt >= RENDER_STORM_ERROR_RATE_LIMIT_MS;
    if (result.isStorm && canEmit) {
      lastErrorEmittedAt = now;
      emitStorm({
        commitsPerSecond: commitsInWindow,
        phaseCounts: phaseCountsInWindow,
      });
    }

    commitsInWindow = 0;
    phaseCountsInWindow = createEmptyPhaseCounts();
    windowStart = now;
  };

  const onRender: RenderStormOnRender = (
    _id,
    phase,
    _actualDuration,
    _baseDuration,
    _startTime,
    commitTime,
  ) => {
    if (windowStart === undefined) {
      windowStart = commitTime;
    } else if (commitTime - windowStart >= RENDER_STORM_WINDOW_MS) {
      closeWindow(commitTime);
    }

    commitsInWindow += 1;
    phaseCountsInWindow[phase] += 1;
  };

  return { onRender };
};
