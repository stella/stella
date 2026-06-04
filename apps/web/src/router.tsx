import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { enableMapSet } from "immer";

import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { createAnalyticsValue } from "@/lib/analytics/provider";
import { STALE_TIME } from "@/lib/consts";
import { installPDFDocumentCleanup } from "@/lib/pdf/hooks/use-pdf-document";
import { routeTree } from "@/routeTree.gen";

enableMapSet();

export function getRouter() {
  const analyticsValue = createAnalyticsValue();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.FIVE.MINUTES,
      },
    },
  });
  installPDFDocumentCleanup(queryClient);

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { analyticsValue, queryClient },
    // Keep browser scroll restoration after hydration, but avoid rendering
    // TanStack's restoration sibling during server streaming for client-only
    // top-level routes.
    scrollRestoration: !import.meta.env.SSR,
    defaultNotFoundComponent: DefaultNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
    defaultPendingComponent: DefaultPendingComponent,
    // Don't flash the pending spinner on fast navigations. Routes
    // that resolve in under 500ms never show a loading state; when
    // the spinner does appear, keep it visible for at least 300ms
    // to avoid flicker when the loader completes just after the
    // threshold.
    defaultPendingMs: 500,
    defaultPendingMinMs: 300,
  });

  router.subscribe("onResolved", ({ toLocation }) => {
    analyticsValue.analytics.capturePageViewed({
      path: toLocation.pathname,
    });
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    wrapQueryClient: false,
  });

  return router;
}

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line consistent-type-definitions
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
