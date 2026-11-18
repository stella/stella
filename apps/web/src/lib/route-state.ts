/**
 * Which phase of its page a component renders. Both renders are the same
 * page: `pending` is the page the URL describes before its data has arrived,
 * and `loaded` is that page with its data.
 */
export type RouteState = "pending" | "loaded";
