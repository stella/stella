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
  version: "0.9.1",
  commit: "962685f5a334f6c9d8516d2d7c1fdd08891b687c",
} as const;
