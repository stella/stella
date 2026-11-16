import { panic } from "better-result";

/**
 * A swipeable row's geometry, in points measured from its leading edge
 * towards its trailing one, so the same numbers hold in either reading
 * direction; the row turns them into screen coordinates. A positive offset
 * slides the row towards its trailing edge and shows its leading action, as
 * Mail's swipe to mark read does; a negative one shows its trailing action.
 */

/** How far a row slides open to show an action: wide enough to tap. */
export const SWIPE_REVEAL_WIDTH = 96;

/** Past this share of the row's width, letting go runs the action at once. */
const FULL_SWIPE_SHARE = 0.5;

/** How far a finger moves sideways before the row, not the list, takes it. */
const CLAIM_DISTANCE = 10;

/** A sideways flick this fast, in points per millisecond, opens or closes the row. */
const FLICK_VELOCITY = 0.5;

/** The edge of a row an action shows at. */
export const SWIPE_SIDE = {
  leading: "leading",
  trailing: "trailing",
} as const;
export type SwipeSide = (typeof SWIPE_SIDE)[keyof typeof SWIPE_SIDE];

/** Where a row rests between gestures: closed, or open on one side's action. */
export type SwipeRest =
  | { readonly type: "closed" }
  | { readonly type: "open"; readonly side: SwipeSide };

/** What letting go of a row does. */
export type SwipeSettle =
  | { readonly type: "close" }
  | { readonly type: "open"; readonly side: SwipeSide }
  | { readonly type: "run"; readonly side: SwipeSide };

export const SWIPE_CLOSED: SwipeRest = { type: "closed" };
const CLOSE: SwipeSettle = { type: "close" };

type Gesture = {
  /** Travel since the touch began, towards the trailing edge. */
  readonly dx: number;
  readonly dy: number;
  readonly rest: SwipeRest;
  /** The sides that have an action to show. */
  readonly sides: readonly SwipeSide[];
};

/** Which side a sideways travel shows: the leading one when it heads trailing. */
const sideOf = (offset: number): SwipeSide =>
  offset > 0 ? SWIPE_SIDE.leading : SWIPE_SIDE.trailing;

/** Where a row at `rest` stands, from its leading edge. */
export const restOffset = (rest: SwipeRest): number => {
  switch (rest.type) {
    case "closed":
      return 0;
    case "open":
      return rest.side === SWIPE_SIDE.leading
        ? SWIPE_REVEAL_WIDTH
        : -SWIPE_REVEAL_WIDTH;
    default:
      rest satisfies never;
      return panic("unknown swipe rest");
  }
};

/**
 * Whether a moving touch is the row's to take: clearly sideways, and while
 * closed only towards a side with an action, so the other way and every
 * mostly vertical drag stay the list's to scroll.
 */
export const claimsSwipe = ({ dx, dy, rest, sides }: Gesture): boolean =>
  Math.abs(dx) > CLAIM_DISTANCE &&
  Math.abs(dx) > Math.abs(dy) * 2 &&
  (rest.type === "open" || sides.includes(sideOf(dx)));

/**
 * How far the row stands open under the finger: never past either edge, and
 * never towards a side with no action.
 */
export const swipeOffset = ({
  dx,
  rest,
  sides,
  width,
}: Omit<Gesture, "dy"> & { readonly width: number }): number => {
  const reach = Math.max(0, width);
  const most = sides.includes(SWIPE_SIDE.leading) ? reach : 0;
  const least = sides.includes(SWIPE_SIDE.trailing) ? -reach : 0;
  return Math.min(most, Math.max(least, restOffset(rest) + dx));
};

/**
 * What letting go at `offset` does: a full swipe runs the action on the side
 * it shows, a flick or a drag past half the action's width leaves it
 * showing, anything less closes the row.
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
  if (offset === 0) {
    return CLOSE;
  }
  const side = sideOf(offset);
  const shown = Math.abs(offset);
  // How fast the finger moves to show more of this side's action.
  const opening = side === SWIPE_SIDE.leading ? velocity : -velocity;
  if (width > 0 && shown >= width * FULL_SWIPE_SHARE) {
    return { type: "run", side };
  }
  if (opening <= -FLICK_VELOCITY) {
    return CLOSE;
  }
  if (opening >= FLICK_VELOCITY || shown >= SWIPE_REVEAL_WIDTH / 2) {
    return { type: "open", side };
  }
  return CLOSE;
};
