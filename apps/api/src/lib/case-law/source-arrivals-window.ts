import { DAY_IN_MS } from "@stll/time";

const HOUR_IN_MS = 60 * 60 * 1000;

/** The window "added last week" counts: seven days back from the count. */
export const SOURCE_ARRIVALS_WINDOW_MS = 7 * DAY_IN_MS;

/** How often the scheduler recounts every source's week. */
export const SOURCE_ARRIVALS_REFRESH_INTERVAL_MS = 3 * HOUR_IN_MS;

/**
 * How old a stored count may be and still be published as this week's: two
 * missed refreshes and an hour of margin. Past it the figure is unknown.
 */
export const SOURCE_ARRIVALS_FRESHNESS_MS =
  2 * SOURCE_ARRIVALS_REFRESH_INTERVAL_MS + HOUR_IN_MS;
