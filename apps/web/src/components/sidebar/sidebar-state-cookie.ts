/** Shared with browser-free e2e setup so a seeded cookie matches SSR. */
export const SIDEBAR_STATE_COOKIE = "sidebar_state";

export const SIDEBAR_STATE_VALUES = {
  expanded: "expanded",
  collapsed: "collapsed",
} as const;
