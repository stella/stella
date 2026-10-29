// The loader's contract, shared by its two renderers: the web's spinner
// (./loader.tsx) and React Native's (./loader.native.tsx, the platform's
// activity indicator).

/** Inline beside a busy control (`sm`), in a row or panel (`md`), or a region (`lg`). */
export const LOADER_SIZES = ["sm", "md", "lg"] as const;

export type LoaderSize = (typeof LOADER_SIZES)[number];

/** The props every loader renderer accepts, with one meaning. */
export type LoaderContract = { size?: LoaderSize } & (
  | {
      variant?: "status";
      /** What is pending, for assistive technology ("Loading matters"). */
      label: string;
    }
  | {
      /** The surrounding control or text announces the pending state. */
      variant: "decorative";
      label?: never;
    }
);
