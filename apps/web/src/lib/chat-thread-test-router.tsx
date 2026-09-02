import type { ReactNode } from "react";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";

const rootRoute = createRootRoute();

/**
 * Router context for static test renders of chat chrome that links to or
 * navigates between threads. It carries only the two destinations
 * `chatThreadRoute` can produce, so a `Link` resolves a real href and
 * `useNavigate` has a router to bind to; nothing here matches or loads a
 * route, which keeps `renderToStaticMarkup` synchronous.
 */
export const ChatThreadTestRouter = ({ children }: { children: ReactNode }) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/chat/thread"] }),
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/chat/$threadId" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/chat/workspaces/$workspaceId/$threadId",
      }),
    ]),
  });
  return (
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  );
};
