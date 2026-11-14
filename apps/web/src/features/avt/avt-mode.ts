/**
 * How the AVT view shows a list: the review of its documents (the default,
 * no search value), the graph of statements, claims, facts and sources, or
 * the chronology of its facts. A view mode of the browser, not of the API.
 * Kept free of imports so the route's search schema reads it without
 * loading the view.
 */
const AVT_MODE = {
  graph: "graph",
  chronology: "chronology",
} as const;
export type AvtMode = (typeof AVT_MODE)[keyof typeof AVT_MODE];

export const AVT_MODES: readonly AvtMode[] = Object.values(AVT_MODE);
