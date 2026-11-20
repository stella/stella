import { useRouterState } from "@tanstack/react-router";

/**
 * What a route's page does with the member's inspector when it is entered.
 * `opens-page-tab`: the page opens a tab of its own in the pane and shows the
 * pane (the document page opens its file), so the pane is open once the page
 * is, whatever the member left it as. Every frame drawn before such a page
 * (the server's cold paint, the loading frame, the member frame while the
 * route loads) reserves the pane, so the content column keeps its width when
 * the page arrives.
 */
export type RouteInspectorEntry = "opens-page-tab";

/** What the rendered leaf route declares it does with the inspector. */
export const useLeafRouteInspectorEntry = (): RouteInspectorEntry | undefined =>
  // The rendered matches, not a navigation still resolving: the page on
  // screen keeps its width until the router shows the route being entered.
  useRouterState({
    select: ({ matches }) => matches.at(-1)?.staticData.inspector,
  });

/**
 * Whether the member frame, which stays up once the page renders, keeps the
 * pane's room: until the entered route's page renders, after which the
 * page's own tab (or the member closing it) decides.
 */
export const useRouteReservesInspectorPane = (): boolean =>
  useRouterState({
    select: ({ matches }) => {
      const leaf = matches.at(-1);
      return (
        leaf?.staticData.inspector === "opens-page-tab" &&
        leaf.status !== "success"
      );
    },
  });
