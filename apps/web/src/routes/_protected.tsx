import { createFileRoute, Outlet } from "@tanstack/react-router";

import {
  loadProtectedContext,
  prefetchProtectedShell,
  ProtectedAppFrame,
  ProtectedPendingSkeleton,
} from "@/routes/-protected-app";

export const Route = createFileRoute("/_protected")({
  ssr: false,
  beforeLoad: loadProtectedContext,
  loader: prefetchProtectedShell,
  component: ProtectedComponent,
  // This subtree is private and client-only. Rendering a loading
  // shell in SSR gives no SEO value and previously tripped React's
  // streamed Suspense boundary path under Bun in CI, so the fallback
  // must stay PURE STATIC: plain layout divs + Skeleton blocks, no
  // hooks, context, data, lazy(), or Suspense. It renders identically
  // on server and client to shape the shell during hydration instead
  // of flashing a blank white screen.
  pendingComponent: ProtectedPendingSkeleton,
});

function ProtectedComponent() {
  const user = Route.useRouteContext({ select: (ctx) => ctx.user });
  return (
    <ProtectedAppFrame user={user}>
      <Outlet />
    </ProtectedAppFrame>
  );
}
