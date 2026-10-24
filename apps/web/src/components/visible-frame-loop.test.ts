import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createVisibleFrameLoop } from "./visible-frame-loop";

// A deterministic frame clock: callbacks queue until `advanceFrames` runs
// them, one batch per frame, as the browser does.
let nextFrameId = 1;
let pending = new Map<number, FrameRequestCallback>();
const original = {
  cancel: globalThis.cancelAnimationFrame,
  request: globalThis.requestAnimationFrame,
};

const advanceFrames = (count: number) => {
  for (let index = 0; index < count; index += 1) {
    const due = pending;
    pending = new Map();
    for (const runFrame of due.values()) {
      runFrame(index);
    }
  }
};

beforeEach(() => {
  nextFrameId = 1;
  pending = new Map();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = original.request;
  globalThis.cancelAnimationFrame = original.cancel;
});

const drawsOver = (
  frames: number,
  script: (loop: ReturnType<typeof createVisibleFrameLoop>) => void,
) => {
  let draws = 0;
  const loop = createVisibleFrameLoop(() => {
    draws += 1;
  });
  script(loop);
  advanceFrames(frames);
  return { draws, armed: pending.size, loop };
};

describe("createVisibleFrameLoop", () => {
  for (const frames of [60, 600]) {
    test(`draws once per frame while visible (${frames} frames)`, () => {
      const { draws, armed } = drawsOver(frames, (loop) => {
        loop.setVisible(true);
      });
      expect(draws).toBe(frames);
      expect(armed).toBe(1);
    });

    test(`draws nothing while off screen (${frames} frames)`, () => {
      const { draws, armed } = drawsOver(frames, (loop) => {
        loop.setVisible(true);
        loop.setVisible(false);
      });
      expect(draws).toBe(0);
      expect(armed).toBe(0);
    });

    test(`draws nothing before the first visibility report (${frames} frames)`, () => {
      const { draws, armed } = drawsOver(frames, () => undefined);
      expect(draws).toBe(0);
      expect(armed).toBe(0);
    });
  }

  test("resumes with one frame when the surface returns, and stop disarms it", () => {
    const { loop } = drawsOver(10, (frameLoop) => {
      frameLoop.setVisible(true);
    });
    loop.setVisible(false);
    advanceFrames(10);
    expect(pending.size).toBe(0);
    loop.setVisible(true);
    loop.setVisible(true);
    expect(pending.size).toBe(1);
    loop.stop();
    expect(pending.size).toBe(0);
  });

  test("visibility reports during a draw retain one pending frame", () => {
    let draws = 0;
    const loop = createVisibleFrameLoop(() => {
      draws += 1;
      loop.setVisible(true);
    });
    loop.setVisible(true);
    for (let frame = 0; frame < 60; frame += 1) {
      advanceFrames(1);
      expect(draws).toBe(frame + 1);
      expect(pending.size).toBe(1);
    }
    loop.stop();
    expect(pending.size).toBe(0);
  });

  test("a hide reported during a draw ends the loop", () => {
    let draws = 0;
    const loop = createVisibleFrameLoop(() => {
      draws += 1;
      loop.setVisible(false);
    });
    loop.setVisible(true);
    advanceFrames(60);
    expect(draws).toBe(1);
    expect(pending.size).toBe(0);
  });
});
