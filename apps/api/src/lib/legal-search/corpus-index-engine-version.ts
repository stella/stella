/**
 * Quickwit binary that built every final q09 corpus generation. It is part of
 * each generation's manifest digest, so it never moves for a generation that
 * already exists; a generation built by another binary declares its own.
 */
export const QUICKWIT_V09_BUILD_VERSION = "0.9.0";

/**
 * Quickwit release the local stack and CI run against q09 generations. Any
 * 0.9.x patch release reads splits built by `QUICKWIT_V09_BUILD_VERSION`.
 */
export const QUICKWIT_V09_RUNTIME = {
  version: "0.9.2",
  commit: "6a1e3f2386b62ba7e363f486a2c97ebbb54a9541",
} as const;
