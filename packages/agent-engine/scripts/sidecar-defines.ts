/**
 * What the sidecar build replaces in the source: the version the desktop
 * was stamped with, and the stella browser's two switches, off: a release
 * build reads none of its test hooks and never starts it, which stays a
 * development host until its network rules match the extension's
 * (`src/sidecar/env.ts`). Bun's define replaces a dotted and a bracketed
 * read of a variable alike; the build test runs a bundle with both set to
 * prove it.
 */
export const sidecarDefines = (version: string): Record<string, string> => ({
  "process.env.STELLA_SIDECAR_VERSION": JSON.stringify(version),
  "process.env.STELLA_BROWSER_TEST_HOOKS": JSON.stringify("0"),
  "process.env.STELLA_BROWSER_DEV_HOST": JSON.stringify("0"),
});
