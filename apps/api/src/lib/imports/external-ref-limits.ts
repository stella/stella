/** Lengths match the calendar sync columns on `entities`. */
export const EXTERNAL_SOURCE_MAX_LENGTH = 64;
export const EXTERNAL_ID_MAX_LENGTH = 256;

/** A stable lowercase key, so `Files` and `files` cannot name two systems. */
export const EXTERNAL_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
