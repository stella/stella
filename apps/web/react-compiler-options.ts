import type { ReactCompilerOptions } from "oxc-transform-react";

export const REACT_COMPILER_OPTIONS = {
  panicThreshold: "none",
  target: "19",
} as const satisfies ReactCompilerOptions;
