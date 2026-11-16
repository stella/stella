// The status mark's drawing, shared by the web's `StatusMark`
// (./status-mark.tsx) and the React Native run mark
// (./run-state-mark.native.tsx), so a ring turning on a phone is the one the
// web draws: a 16-unit box with a 1.5 stroke, the ring inside the box edge.

export const STATUS_MARK_VIEWBOX = "0 0 16 16";
export const STATUS_MARK_STROKE_WIDTH = 1.5;
export const STATUS_MARK_RING_RADIUS = 6.25;

/**
 * The running arc's share of the ring and the faint track it runs on. The
 * web spells them as utilities (`[stroke-dasharray:30_70]`, `opacity-20`),
 * which must stay literal for Tailwind to find them.
 */
export const STATUS_MARK_RUNNING_ARC = 0.3;
export const STATUS_MARK_TRACK_OPACITY = 0.2;

/** One turn of the running arc: `--animate-status-spin` in the theme. */
export const STATUS_MARK_SPIN_MS = 1100;
