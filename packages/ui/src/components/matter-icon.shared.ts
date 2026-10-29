// The matter glyph's contract, shared by its two renderers: the web's
// (./matter-icon.tsx) and React Native's (./matter-icon.native.tsx). A
// specific matter is drawn only in its own colour; the two other forms are
// the muted "no matter" glyph and the tri-plane "all matters" stack.

export type MatterIconContract =
  | { matter: { id: string; color: string | null } }
  | { variant: "none" | "all" };

/** The three planes of the "all matters" glyph, top to bottom, in their tints. */
export const ALL_MATTERS_STACK = [
  {
    d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
    option: "red",
  },
  {
    d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",
    option: "blue",
  },
  {
    d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
    option: "green",
  },
] as const;
