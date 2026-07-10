import { describe, expect, it } from "bun:test";

import {
  createRenderStormMonitor,
  evaluateStormWindow,
  RENDER_STORM_SUSTAINED_WINDOWS_REQUIRED,
  RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND,
  RENDER_STORM_WINDOW_MS,
} from "./render-storm-canary";

describe("evaluateStormWindow", () => {
  it("resets the streak when a window is under threshold", () => {
    const result = evaluateStormWindow(20, 80, 0);
    expect(result).toEqual({ consecutiveStormWindows: 0, isStorm: false });
  });

  it("treats a count exactly at threshold as not over it", () => {
    const result = evaluateStormWindow(80, 80, 1);
    expect(result).toEqual({ consecutiveStormWindows: 0, isStorm: false });
  });

  it("starts a streak on the first over-threshold window without reporting a storm", () => {
    const result = evaluateStormWindow(200, 80, 0);
    expect(result).toEqual({ consecutiveStormWindows: 1, isStorm: false });
  });

  it("reports a storm once the streak reaches the sustained-windows requirement", () => {
    const first = evaluateStormWindow(200, 80, 0);
    const second = evaluateStormWindow(200, 80, first.consecutiveStormWindows);
    expect(second).toEqual({ consecutiveStormWindows: 2, isStorm: true });
    expect(second.consecutiveStormWindows).toBeGreaterThanOrEqual(
      RENDER_STORM_SUSTAINED_WINDOWS_REQUIRED,
    );
  });

  it("keeps reporting a storm while the streak continues past the requirement", () => {
    const result = evaluateStormWindow(200, 80, 2);
    expect(result).toEqual({ consecutiveStormWindows: 3, isStorm: true });
  });

  it("resets an in-progress streak the moment a window drops back under threshold", () => {
    const result = evaluateStormWindow(10, 80, 5);
    expect(result).toEqual({ consecutiveStormWindows: 0, isStorm: false });
  });
});

describe("createRenderStormMonitor", () => {
  const PHASE = "update" as const;

  it("does not emit for commits that never exceed the threshold", () => {
    const emitted: unknown[] = [];
    const monitor = createRenderStormMonitor((details) => {
      emitted.push(details);
    });

    let time = 0;
    // ~20 commits/sec for 3 windows worth of time — legitimate streaming rate.
    for (let window = 0; window < 3; window += 1) {
      for (let commit = 0; commit < 20; commit += 1) {
        monitor.onRender("app", PHASE, 1, 1, time, time);
        time += RENDER_STORM_WINDOW_MS / 20;
      }
    }

    expect(emitted).toEqual([]);
  });

  it("emits once a storm sustains for the required consecutive windows", () => {
    const emitted: { commitsPerSecond: number }[] = [];
    const monitor = createRenderStormMonitor((details) => {
      emitted.push(details);
    });

    let time = 0;
    const commitsPerWindow = RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND + 50;
    // Window 1: over threshold, no emission yet (streak length 1).
    // Window 2: over threshold again, closes window 1 and reports the storm.
    // A final commit closes window 2 and evaluates it.
    for (let window = 0; window < 3; window += 1) {
      for (let commit = 0; commit < commitsPerWindow; commit += 1) {
        monitor.onRender("app", PHASE, 1, 1, time, time);
        time += RENDER_STORM_WINDOW_MS / commitsPerWindow;
      }
      time = (window + 1) * RENDER_STORM_WINDOW_MS;
    }
    // One more commit far enough ahead to force the last window closed.
    monitor.onRender("app", PHASE, 1, 1, time, time + 1);

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0]?.commitsPerSecond).toBeGreaterThan(
      RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND,
    );
  });

  it("rate-limits repeat emissions to at most one per RENDER_STORM_ERROR_RATE_LIMIT_MS", () => {
    const emitted: unknown[] = [];
    const monitor = createRenderStormMonitor((details) => {
      emitted.push(details);
    });

    const commitsPerWindow = RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND + 50;
    let time = 0;
    // Ten consecutive storming windows, well past the rate-limit interval.
    for (let window = 0; window < 10; window += 1) {
      for (let commit = 0; commit < commitsPerWindow; commit += 1) {
        monitor.onRender("app", PHASE, 1, 1, time, time);
        time += RENDER_STORM_WINDOW_MS / commitsPerWindow;
      }
      time = (window + 1) * RENDER_STORM_WINDOW_MS;
    }
    monitor.onRender("app", PHASE, 1, 1, time, time + 1);

    // 10 windows spanning ~10s at the rate limit boundary should emit far
    // fewer than once per window.
    expect(emitted.length).toBeLessThan(10);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
  });

  it("tracks phase counts for the window that triggers the storm", () => {
    const emitted: { phaseCounts: Record<string, number> }[] = [];
    const monitor = createRenderStormMonitor((details) => {
      emitted.push(details);
    });

    let time = 0;
    const commitsPerWindow = RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND + 20;
    for (let window = 0; window < 2; window += 1) {
      for (let commit = 0; commit < commitsPerWindow; commit += 1) {
        monitor.onRender("app", "nested-update", 1, 1, time, time);
        time += RENDER_STORM_WINDOW_MS / commitsPerWindow;
      }
      time = (window + 1) * RENDER_STORM_WINDOW_MS;
    }
    monitor.onRender("app", PHASE, 1, 1, time, time + 1);

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0]?.phaseCounts["nested-update"]).toBeGreaterThan(0);
  });

  it("does not treat bursts separated by idle time as sustained throughput", () => {
    const emitted: unknown[] = [];
    const monitor = createRenderStormMonitor((details) => {
      emitted.push(details);
    });

    const commitsPerBurst = RENDER_STORM_THRESHOLD_COMMITS_PER_SECOND + 20;
    for (let commit = 0; commit < commitsPerBurst; commit += 1) {
      monitor.onRender("app", PHASE, 1, 1, commit, commit);
    }

    const afterFirstIdle = 30_000;
    monitor.onRender("app", PHASE, 1, 1, afterFirstIdle, afterFirstIdle);
    for (let commit = 1; commit < commitsPerBurst; commit += 1) {
      monitor.onRender(
        "app",
        PHASE,
        1,
        1,
        afterFirstIdle + commit,
        afterFirstIdle + commit,
      );
    }

    const afterSecondIdle = 60_000;
    monitor.onRender("app", PHASE, 1, 1, afterSecondIdle, afterSecondIdle);

    expect(emitted).toEqual([]);
  });
});
