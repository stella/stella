// Bun hands onLoad the native file path, so a filter must accept either
// separator to match on Windows as well as POSIX.

/** A stylesheet of the reader's serif font package. */
export const READER_FONT_STYLESHEET = /source-serif-4[\\/].*\.css$/u;

/** A module under the shared generated assets directory. */
export const SHARED_GENERATED_MODULE = /shared[\\/]generated[\\/]/u;
