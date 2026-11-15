/**
 * What the sidecar build replaces in the source: the version the desktop
 * was stamped with, and the stella browser's test hooks switch, off, so a
 * release build reads none of the hooks (`src/sidecar/env.ts`). Bun's
 * define replaces a dotted and a bracketed read of a variable alike; the
 * build test runs a bundle with every hook set to prove it.
 */
export const sidecarDefines = (version: string): Record<string, string> => ({
  "process.env.STELLA_SIDECAR_VERSION": JSON.stringify(version),
  "process.env.STELLA_BROWSER_TEST_HOOKS": JSON.stringify("0"),
});
