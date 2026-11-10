/**
 * A swipeable row's geometry, in points measured from its leading edge
 * towards its trailing one, so the same numbers hold in either reading
 * direction; the row turns them into screen coordinates.
 */

/** How far a row slides open to show its action: wide enough to tap. */
export const SWIPE_REVEAL_WIDTH = 96;

/** Past this share of the row's width, letting go runs the action at once. */
const FULL_SWIPE_SHARE = 0.5;

/** How far a finger moves sideways before the row, not the list, takes it. */
const CLAIM_DISTANCE = 10;

/** A sideways flick this fast, in points per millisecond, opens or closes the row. */
const FLICK_VELOCITY = 0.5;

/** Where a row rests between gestures. */
export type SwipeRest = "closed" | "open";

/** What letting go of a row does. */
export type SwipeSettle = "close" | "open" | "run";

type Gesture = {
  /** Travel since the touch began, towards the trailing edge. */
  readonly dx: number;
  readonly dy: number;
  readonly rest: SwipeRest;
};

/**
 * Whether a moving touch is the row's to take: clearly sideways, and while
 * closed only towards the trailing edge, so the other way and every mostly
 * vertical drag stay the list's to scroll.
 */
export const claimsSwipe = ({ dx, dy, rest }: Gesture): boolean =>
  Math.abs(dx) > CLAIM_DISTANCE &&
  Math.abs(dx) > Math.abs(dy) * 2 &&
  (rest === "open" || dx > 0);

/** How far the row stands open under the finger: never past either edge. */
export const swipeOffset = ({
  dx,
  rest,
  width,
}: Omit<Gesture, "dy"> & { readonly width: number }): number =>
  Math.min(
    Math.max(0, width),
    Math.max(0, (rest === "open" ? SWIPE_REVEAL_WIDTH : 0) + dx),
  );

/**
 * What letting go at `offset` does: a full swipe runs the action, a flick or
 * a drag past half the action's width leaves it showing, anything less
 * closes the row.
 */
export const swipeSettle = ({
  offset,
  velocity,
  width,
}: {
  readonly offset: number;
  /** Towards the trailing edge, in points per millisecond. */
  readonly velocity: number;
  readonly width: number;
}): SwipeSettle => {
  if (width > 0 && offset >= width * FULL_SWIPE_SHARE) {
    return "run";
  }
  if (velocity <= -FLICK_VELOCITY || offset === 0) {
    return "close";
  }
  if (velocity >= FLICK_VELOCITY || offset >= SWIPE_REVEAL_WIDTH / 2) {
    return "open";
  }
  return "close";
};
