/**
 * What the sidecar build replaces in the source: the version the desktop
 * was stamped with, and the stella browser's test hooks switch, off, so a
 * release build reads none of the hooks (`src/sidecar/env.ts`). Bun's
 * define matches `process.env.NAME` and `process.env["NAME"]` alike.
 */
export const sidecarDefines = (version: string): Record<string, string> => ({
  "process.env.STELLA_SIDECAR_VERSION": JSON.stringify(version),
  "process.env.STELLA_BROWSER_TEST_HOOKS": JSON.stringify("0"),
});
