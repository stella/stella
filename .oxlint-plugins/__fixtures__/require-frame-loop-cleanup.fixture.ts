// Passive regression fixture for
// `require-frame-loop-cleanup/require-frame-loop-cleanup`.
//
// Rule-specific disables mark loop starts the rule MUST reject. If detection
// regresses, unused-directive reporting fails this fixture. Unannotated calls
// cover owned, bounded and one-shot shapes the rule accepts.

declare const useMountEffect: (effect: () => (() => void) | undefined) => void;
declare const useExternalSyncEffect: (
  effect: () => (() => void) | undefined,
  deps: readonly unknown[],
) => void;
declare const draw: () => void;
declare const isReady: () => boolean;
declare const onStop: (stop: () => void) => void;
declare const frameRef: { current: number | null };

// MUST flag: a discarded interval handle can never be cleared.
export const discardedInterval = () => {
  // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: interval handle is discarded
  setInterval(draw, 1000);
};

// MUST flag: a clear inside the timer callback is a stop condition, not an
// owner cancel; unmount before it fires leaves the timer running.
export const selfStoppingInterval = () => {
  // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: only the callback clears the timer
  const id = window.setInterval(() => {
    if (isReady()) {
      clearInterval(id);
    }
  }, 80);
};

// MUST flag: the effect's cleanup does not clear the interval it started.
export const EffectWithoutClear = () => {
  useMountEffect(() => {
    // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: the clear lives in a timeout, not the cleanup
    const id = setInterval(draw, 80);
    const fallback = setTimeout(() => {
      clearInterval(id);
    }, 3000);
    return () => {
      clearTimeout(fallback);
    };
  });
};

// MUST flag: a frame loop that reschedules on every frame never idles.
export const IdleFrameLoop = () => {
  useMountEffect(() => {
    let frame = 0;
    const tick = () => {
      draw();
      // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: unconditional reschedule
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  });
};

// MUST flag: an unbounded polling loop whose frames nobody can cancel.
export const unownedPoll = () => {
  const poll = () => {
    if (!isReady()) {
      // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: reschedule handle is discarded
      requestAnimationFrame(poll);
    }
  };
  // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: kick-off handle is discarded
  requestAnimationFrame(poll);
};

// MUST flag: the stop function is handed out, but the effect returns no
// cleanup, so unmount does not cancel the loop.
export const EffectLoopWithoutCleanup = () => {
  useMountEffect(() => {
    let frame = 0;
    const sync = () => {
      if (!isReady()) {
        // oxlint-disable-next-line require-frame-loop-cleanup/require-frame-loop-cleanup -- fixture: cancel is not in the effect cleanup
        frame = requestAnimationFrame(sync);
      }
    };
    sync();
    onStop(() => {
      cancelAnimationFrame(frame);
    });
    return undefined;
  });
};

// Allowed: the effect cleanup clears the interval it started.
// expect-clean: require-frame-loop-cleanup/require-frame-loop-cleanup
export const OwnedInterval = () => {
  useExternalSyncEffect(() => {
    const id = setInterval(draw, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
};

// Allowed: a factory hands its caller the stop function.
export const intervalFactory = () => {
  const heartbeat = globalThis.setInterval(draw, 2000);
  return {
    stop: () => {
      clearInterval(heartbeat);
    },
  };
};

// Allowed: the handle lives in a ref the owner clears.
export const scheduleInRef = () => {
  frameRef.current = setInterval(draw, 500);
};
export const clearRef = () => {
  if (frameRef.current !== null) {
    clearInterval(frameRef.current);
  }
};

// Allowed: an unbounded loop whose effect cleanup cancels the pending frame,
// including a cleanup bound to a name before it is returned.
export const OwnedFrameLoop = () => {
  useMountEffect(() => {
    let frame = 0;
    const sync = () => {
      if (isReady()) {
        draw();
        return;
      }
      frame = requestAnimationFrame(sync);
    };
    sync();
    const cleanup = () => {
      cancelAnimationFrame(frame);
    };
    return cleanup;
  });
};

// Allowed: a bounded retry ends on its own after a fixed number of frames.
export const boundedRetry = () => {
  let attempts = 0;
  const read = () => {
    if (isReady()) {
      draw();
      return;
    }
    attempts += 1;
    if (attempts < 10) {
      requestAnimationFrame(read);
    }
  };
  requestAnimationFrame(read);
};

// Allowed: a one-shot frame deferral finishes within one frame.
export const oneShot = () => {
  requestAnimationFrame(() => {
    draw();
  });
};

// Allowed: the handle is passed to the caller's callback, which owns it.
export const scheduleThrough = (onFrame: (frame: number) => void): void => {
  if (isReady()) {
    return;
  }
  const frame = requestAnimationFrame(() => {
    scheduleThrough(onFrame);
  });
  onFrame(frame);
};

// Allowed: a local function that shadows the browser API is not the timer.
export const shadowed = (setInterval: (callback: () => void) => number) =>
  setInterval(draw);
