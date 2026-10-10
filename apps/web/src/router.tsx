import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { enableMapSet } from "immer";

import { installDocxDocumentCacheInvalidation } from "@/components/docx/docx-document-cache";
import { resolvedRouteIdsStore } from "@/components/inspector/resolved-route-ids";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { installChatRuntimeCleanup } from "@/features/chat/queries";
import { installUserScopedStorage } from "@/lib/account/install-user-scoped-storage";
import { installSessionChangeListener } from "@/lib/account/session-change-listener";
import { listenForSessionDocumentRestore } from "@/lib/account/session-document";
import { listenForSessionChange } from "@/lib/account/session-signal";
import { createAnalyticsValue } from "@/lib/analytics/provider";
import {
  createRouteErrorLifecycleController,
  resolveCaughtRouteTemplate,
} from "@/lib/analytics/route-error-lifecycle";
import { installPDFDocumentCleanup } from "@/lib/pdf/hooks/use-pdf-document";
import { createAppQueryClient } from "@/lib/react-query";
import { isAuthFlowPathname } from "@/lib/redirect";
import { installSessionCacheGuard } from "@/lib/session-cache-guard";
import { installTableStoreReconcile } from "@/lib/workspaces/table-store";
import { routeTree } from "@/routeTree.gen";

enableMapSet();

export function getRouter() {
  const analyticsValue = createAnalyticsValue();
  const routeErrorLifecycle = createRouteErrorLifecycleController(
    analyticsValue.analytics,
  );
  const queryClient = createAppQueryClient();
  installPDFDocumentCleanup(queryClient);
  installDocxDocumentCacheInvalidation(queryClient);
  installChatRuntimeCleanup(queryClient);
  installTableStoreReconcile(queryClient);
  installSessionCacheGuard(queryClient, {
    isAuthFlowPage: () => isAuthFlowPathname(window.location.pathname),
    reloadDocument: () => {
      window.location.reload();
    },
    reloadDocumentAt: (href) => {
      window.history.replaceState(window.history.state, "", href);
      window.location.reload();
    },
  });
  if (typeof window !== "undefined") {
    installUserScopedStorage(queryClient);
    installSessionChangeListener(queryClient, {
      listen: listenForSessionChange,
      onRestore: listenForSessionDocumentRestore,
      isHidden: () => document.visibilityState === "hidden",
      onVisible: (listener) => {
        const onChange = () => {
          if (document.visibilityState === "visible") {
            listener();
          }
        };
        document.addEventListener("visibilitychange", onChange);
        return () => {
          document.removeEventListener("visibilitychange", onChange);
        };
      },
      reloadDocument: () => {
        window.location.reload();
      },
    });
  }
  let readCaughtRouteTemplate = () => "unknown";

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { analyticsValue, queryClient, routeErrorLifecycle },
    defaultOnCatch: () => {
      routeErrorLifecycle.caught(readCaughtRouteTemplate());
    },
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
  readCaughtRouteTemplate = () =>
    resolveCaughtRouteTemplate(router.state.matches);

  router.subscribe("onResolved", () => {
    resolvedRouteIdsStore.setState({
      routeIds: new Set(router.state.matches.map(({ routeId }) => routeId)),
    });
    // Report the matched route template (e.g. `/workspaces/$workspaceId`),
    // not the resolved pathname. Templates aggregate into a small, stable
    // set of routes; resolved paths embed per-resource ids that fragment
    // every navigation into a unique path and defeat page-view grouping.
    const path = router.state.matches.at(-1)?.fullPath;
    if (path === undefined) {
      return;
    }
    routeErrorLifecycle.routeResolved(path);
    analyticsValue.analytics.capturePageViewed({ path });
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    wrapQueryClient: false,
  });

  return router;
}

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation requires interface for declaration merging
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
