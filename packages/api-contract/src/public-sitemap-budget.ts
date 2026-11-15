/**
 * How long one public sitemap file may take, shared by the web server that
 * serves the file and the API that reads its rows, so neither side's bound can
 * drift past the other's.
 */

/** How long the web server waits for one sitemap file's rows. */
export const SITEMAP_FILE_FETCH_TIMEOUT_MS = 10_000;

/**
 * What serving one sitemap file may take at most, cold caches included: a
 * third of the wait above, so a slow file is still served and never cut off.
 */
export const SITEMAP_FILE_SERVE_TARGET_MS = 3000;
