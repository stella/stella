/** A frame loop that draws only while its surface is on screen. */
export type VisibleFrameLoop = {
  /** Report whether the surface intersects the viewport. */
  setVisible: (visible: boolean) => void;
  /** Cancel the pending frame; the owner calls it on unmount, after it
   *  disconnects whatever reports visibility. */
  stop: () => void;
};

/**
 * Drive `draw` once per animation frame while the surface is visible. Hidden,
 * the loop schedules nothing; becoming visible again restarts it. Starts
 * hidden: the owner's IntersectionObserver reports the first state.
 */
export const createVisibleFrameLoop = (draw: () => void): VisibleFrameLoop => {
  let frame = 0;
  let visible = false;
  const tick = () => {
    frame = 0;
    draw();
    if (visible && frame === 0) {
      frame = requestAnimationFrame(tick);
    }
  };
  const cancel = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  return {
    setVisible: (next) => {
      visible = next;
      if (!visible) {
        cancel();
      } else if (frame === 0) {
        frame = requestAnimationFrame(tick);
      }
    },
    stop: () => {
      visible = false;
      cancel();
    },
  };
};
