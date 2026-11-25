// The composer box's contract, shared by its two renderers: the web's
// (./composer-frame.tsx) and React Native's (./composer-frame.native.tsx).
// Both lay the same slots out the same way, by the one rule in
// ./composer-layout.ts.

import type { ReactNode } from "react";

/**
 * How a frame lays its text and controls out.
 *
 * `bar`: one row: the leading controls, the text, the trailing controls, all
 * centred on the one text line.
 *
 * `stacked`: the text across the whole box on top, the controls in a row
 * beneath it, leading at the start and trailing at the end. Text and
 * controls never share a row, so no control stands beside (or over) a line
 * of text, however long the draft grows.
 */
export type ComposerLayout = "bar" | "stacked";

/**
 * Which composer a frame is.
 *
 * `compact`, the follow-up bar: empty or one line, it is a `bar`; the first
 * time its text needs a second line (a wrap or a line break) it is
 * `stacked`, and it stays stacked until the draft is empty again, so it
 * never flips back and forth at the wrap point while someone types. `empty`
 * is the draft's emptiness, the one thing the switch back reads.
 *
 * `large`, the hero box: always `stacked`, three lines tall while empty.
 */
export type ComposerStature =
  { stature: "compact"; empty: boolean } | { stature: "large"; empty?: never };

/** Which edge treatment the box wears. */
export type ComposerRing = "none" | "focus" | "anonymized" | "attention";

/** The props every composer frame renderer accepts, with one meaning. */
export type ComposerFrameContract = ComposerStature & {
  /** The editable element: an editor, or a `Textarea` with the `composer`
   *  appearance. It grows with its content; the frame caps it and scrolls. */
  text: ReactNode;
  /** Draft attachments, above the text and outside its scroll region. */
  attachments?: ReactNode;
  /** Chrome anchored above the box (preset chips, a floating attachment
   *  tray), positioned by the surface from the box's top edge outward. */
  above?: ReactNode;
  /** The controls at the start: the (+) menu, a scope control. */
  leading?: ReactNode;
  /** The controls at the end, the primary (send) control last. */
  trailing?: ReactNode;
  ring: ComposerRing;
};
