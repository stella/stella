import {
  SITEMAP_FILE_FETCH_TIMEOUT_MS,
  SITEMAP_FILE_SERVE_TARGET_MS,
} from "@stll/api-contract/public-sitemap-budget";

/**
 * How many decisions one case-law sitemap file may read, derived from how
 * long serving the file may take rather than from the protocol's 50,000 URLs.
 *
 * A file's read visits a fixed number of pages per decision it scans (the
 * decision's heap row and its language group's index leaf), so its time is
 * the decisions it scans times the time of one page. The cut and the ceiling
 * below follow from that and from the serve target the web server shares;
 * `sitemap-shard-read-pages.db.test.ts` measures the pages per decision on a
 * corpus in production's shape and fails when the read outgrows them.
 */

/**
 * Page visits the read spends per decision it scans, at most. Measured by the
 * read-pages test, which fails above it.
 */
export const SITEMAP_SHARD_READ_PAGES_PER_ROW = 9;

/**
 * How long one page visit takes the request when nothing is cached, every other
 * leg of the request (transfer, parsing, XML) included: measured end to end
 * on cold sitemap files of the same read shape, divided by their pages.
 */
export const SITEMAP_SHARD_COLD_MS_PER_PAGE = 0.133;

/**
 * The read's share of the serve target. The rest covers the admission wait
 * and moving and rendering the rows.
 */
const SITEMAP_SHARD_READ_TARGET_MS = SITEMAP_FILE_SERVE_TARGET_MS - 1000;

/** How long reading `rows` decisions takes on a cold cache, in milliseconds. */
export const sitemapShardColdReadMs = (rows: number): number =>
  rows * SITEMAP_SHARD_READ_PAGES_PER_ROW * SITEMAP_SHARD_COLD_MS_PER_PAGE;

/**
 * Published decisions a sitemap range is cut at: the most whose cold read
 * fits the read target.
 */
export const SITEMAP_RANGE_ROWS = Math.floor(
  SITEMAP_SHARD_READ_TARGET_MS /
    (SITEMAP_SHARD_READ_PAGES_PER_ROW * SITEMAP_SHARD_COLD_MS_PER_PAGE),
);

/**
 * Published decisions a range may grow to between two recounts before its
 * read refuses it rather than outrun the web server's wait. Decisions written
 * into a month queue its recount, which cuts the range again.
 */
export const SITEMAP_RANGE_ROWS_CEILING = 2 * SITEMAP_RANGE_ROWS;

/**
 * The database deadline of one shard read: past the ceiling's cold time and
 * well inside the web server's wait, so a read the web server has given up on
 * is never still running when the next request for it arrives.
 */
export const SITEMAP_SHARD_READ_DEADLINE_MS = SITEMAP_FILE_FETCH_TIMEOUT_MS / 2;

/**
 * How long a sitemap read may wait for its admission slot: what the web
 * server's wait leaves after the read's deadline and a second for the rest of
 * the request. The web server fetches every sitemap file, so a crawler's
 * concurrent files arrive as one client, which holds one sitemap slot at a
 * time; they queue for it rather than fail while a bounded read runs.
 */
export const SITEMAP_ADMISSION_WAIT_MS =
  SITEMAP_FILE_FETCH_TIMEOUT_MS - SITEMAP_SHARD_READ_DEADLINE_MS - 1000;
