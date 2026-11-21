import type { ReactCompilerOptions } from "oxc-transform-react";

export const REACT_COMPILER_OPTIONS = {
  panicThreshold: "none",
  target: "19",
} as const satisfies ReactCompilerOptions;

export const REACT_COMPILER_EXCLUDE = [
  /[/\\]node_modules[/\\]/u,
  // Sanctioned wrappers accept opaque callbacks and dependency arrays.
  /[/\\]src[/\\]hooks[/\\]use-effect\.ts$/u,
];
