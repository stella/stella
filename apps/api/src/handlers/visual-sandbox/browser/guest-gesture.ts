/**
 * How long a trusted click or key press can back one view action. Handlers
 * that act on the gesture itself run well within it, including chart
 * selection, which fires from the click or key handler; script on a later
 * timer does not.
 */
export const VISUAL_GESTURE_WINDOW_MS = 1000;

/** The gestures that grant a token: a click or a key press. */
const VISUAL_GESTURE_EVENTS = ["click", "keydown"] as const;

type GestureEventTarget = {
  addEventListener: (
    type: (typeof VISUAL_GESTURE_EVENTS)[number],
    listener: (event: { readonly isTrusted: boolean }) => void,
    options: { capture: true },
  ) => void;
};

type VisualGestureGateOptions = {
  now: () => number;
  windowMs?: number;
};

/**
 * One view action per trusted gesture. Every trusted click or key press
 * grants a single token, which the next action spends; a token left unspent
 * for longer than the window lapses.
 */
export const createVisualGestureGate = ({
  now,
  windowMs = VISUAL_GESTURE_WINDOW_MS,
}: VisualGestureGateOptions) => {
  let grantedAt: number | null = null;
  // `isTrusted` is an own, unforgeable property of every event, read here
  // from the event the browser dispatched.
  const observe = (event: { readonly isTrusted: boolean }) => {
    if (event.isTrusted === true) {
      grantedAt = now();
    }
  };
  return Object.freeze({
    observe,
    /**
     * Listens in the capture phase on the window, registered before any page
     * script, so a gesture is observed before page handlers see it.
     */
    listen: (target: GestureEventTarget) => {
      for (const type of VISUAL_GESTURE_EVENTS) {
        target.addEventListener(type, observe, { capture: true });
      }
    },
    take: () => {
      if (grantedAt === null) {
        return false;
      }
      const elapsed = now() - grantedAt;
      grantedAt = null;
      return elapsed >= 0 && elapsed < windowMs;
    },
  });
};
