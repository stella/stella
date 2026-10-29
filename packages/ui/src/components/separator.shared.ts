// The separator's contract, shared by its two renderers: the web's
// (./separator.tsx, through Base UI) and React Native's
// (./separator.native.tsx, a hairline view).

/** The props every separator renderer accepts, with one meaning. */
export type SeparatorContract = {
  orientation?: "horizontal" | "vertical";
};
