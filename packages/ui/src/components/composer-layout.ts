// When a composer is one bar and when it is the text over a control row: the
// one rule both `ComposerFrame` renderers (./composer-frame.tsx on the web,
// ./composer-frame.native.tsx on a phone) follow. Each renderer measures its
// own text and hands the height here; what the layout does with it is the
// same on both.

import { useCallback, useState } from "react";

import type { ComposerLayout, ComposerStature } from "./composer-frame.shared";

/** Above this many line heights, the text is on a second line. */
const SECOND_LINE_THRESHOLD = 1.5;

/**
 * What the layout remembers between renders: whether the text has needed a
 * second line since the draft was last empty, and whether it is empty now.
 */
export type ComposerLayoutState = {
  readonly secondLine: boolean;
  readonly empty: boolean;
};

/** A frame's first state: one line, as empty as its draft. */
export const composerLayoutStart = (empty: boolean): ComposerLayoutState => ({
  secondLine: false,
  empty,
});

/**
 * The draft's emptiness, as the surface reports it. The switch back to the
 * bar happens when the draft becomes empty, not while it is: a draft of
 * blank lines is empty yet several lines tall, and resetting on every report
 * would flip it between the two layouts forever.
 */
export const withDraftEmptiness = (
  state: ComposerLayoutState,
  empty: boolean,
): ComposerLayoutState => {
  if (state.empty === empty) {
    return state;
  }
  return { empty, secondLine: empty ? false : state.secondLine };
};

/**
 * The text's measured height against one line of it: a wrap, a line break
 * and a taller inline chip all count, where a character count would guess.
 * Once on a second line it stays there until the draft is empty again, so it
 * never flips back and forth at the wrap point while someone types.
 */
export const withTextHeight = (
  state: ComposerLayoutState,
  height: number,
  lineHeight: number,
): ComposerLayoutState =>
  !state.secondLine && height > lineHeight * SECOND_LINE_THRESHOLD
    ? { ...state, secondLine: true }
    : state;

/** The layout a frame of this stature draws in this state. */
export const composerLayoutOf = (
  stature: ComposerStature["stature"],
  state: ComposerLayoutState,
): ComposerLayout =>
  stature === "large" || state.secondLine ? "stacked" : "bar";

/**
 * The frame's layout, kept across renders: `measured` takes each new height
 * of the text and one line of it.
 */
export const useComposerLayout = (
  stature: ComposerStature["stature"],
  empty: boolean | undefined,
) => {
  const draftEmpty = empty === true;
  const [state, setState] = useState(() => composerLayoutStart(draftEmpty));
  const current = withDraftEmptiness(state, draftEmpty);
  if (current !== state) {
    setState(current);
  }
  // Stable, so a measuring ref or observer set up once keeps reporting.
  const measured = useCallback((height: number, lineHeight: number) => {
    setState((latest) => withTextHeight(latest, height, lineHeight));
  }, []);
  return {
    layout: composerLayoutOf(stature, current),
    measured,
  };
};
