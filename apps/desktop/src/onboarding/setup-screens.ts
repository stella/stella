/**
 * Moves between the screens of a setup step whose screens follow live
 * state, such as Dictation or Activity: `order` is every screen the step
 * has, in order, and `screens` the ones that apply now. A screen can stop
 * applying while it is shown; the next one that applies takes its place.
 */

import { panic } from "better-result";

type SetupScreens<Screen> = {
  /** Every screen of the step, in order. */
  order: readonly Screen[];
  /** The screens that apply now, in the same order. */
  screens: readonly Screen[];
  screen: Screen;
};

/** Where `screen` sits in `screens`, or, when it no longer applies, where
 *  the screen after it that took its place sits. */
const positionOf = <Screen>({
  order,
  screen,
  screens,
}: SetupScreens<Screen>) => {
  const index = screens.indexOf(screen);
  if (index !== -1) {
    return index;
  }
  const rank = order.indexOf(screen);
  const next = screens.findIndex(
    (candidate) => order.indexOf(candidate) > rank,
  );
  return next === -1 ? screens.length - 1 : next;
};

export type SetupMove<Screen> =
  | { screen: Screen; type: "screen" }
  /** Before the first screen: the step before this one. */
  | { type: "leaveBack" }
  /** After the last screen: the step after this one. */
  | { type: "leaveForward" };

/** Where Back or Continue goes from `screen`. */
export const moveFrom = <Screen>(
  setup: SetupScreens<Screen> & { direction: "back" | "continue" },
): SetupMove<Screen> => {
  const { direction, order, screen, screens } = setup;
  const index = positionOf(setup);
  const rank = (candidate: Screen | undefined) =>
    candidate === undefined ? -1 : order.indexOf(candidate);
  // The first screen after `screen`: the next one, or, when `screen`
  // stopped applying, the one that took its place if it comes later.
  const after = rank(screens[index]) > rank(screen) ? index : index + 1;
  // The last screen before it.
  const before = screens[index] === screen ? index - 1 : after - 1;
  const next = screens[direction === "continue" ? after : before];
  if (next !== undefined) {
    return { screen: next, type: "screen" };
  }
  return direction === "continue"
    ? { type: "leaveForward" }
    : { type: "leaveBack" };
};

/** The screen shown for `screen` now: itself, or the one that took its
 *  place when it stopped applying. */
export const shownScreen = <Screen>(setup: SetupScreens<Screen>): Screen =>
  setup.screens[positionOf(setup)] ??
  panic("A setup step must have a screen that applies.");
