/**
 * What the statute list may be narrowed by, as the URL names it. Kept apart
 * from the popover that draws the filters: the route's loader reads the keys,
 * and importing them from a component module would pull the popover into the
 * eagerly loaded route chunk.
 */
export const STATUTE_FILTER_KEYS = ["type", "validity"] as const;

export type StatuteFilterKey = (typeof STATUTE_FILTER_KEYS)[number];
