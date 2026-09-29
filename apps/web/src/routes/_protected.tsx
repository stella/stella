import { createFileRoute } from "@tanstack/react-router";

import {
  loadProtectedContext,
  prefetchProtectedShell,
} from "@/routes/-protected-guard";
import { ProtectedPendingSkeleton } from "@/routes/-protected-pending-skeleton";

// The signed-in frame itself renders from the root (`AppFrameHost`), above
// this guard, so it stays mounted across every signed-in route.
export const Route = createFileRoute("/_protected")({
  ssr: false,
  beforeLoad: loadProtectedContext,
  loader: prefetchProtectedShell,
  // This subtree is private and client-only. Rendering a loading
  // shell in SSR gives no SEO value and previously tripped React's
  // streamed Suspense boundary path under Bun in CI, so the fallback
  // must stay PURE STATIC: plain layout divs + Skeleton blocks, no
  // hooks, context, data, lazy(), or Suspense. It renders identically
  // on server and client to shape the shell during hydration instead
  // of flashing a blank white screen.
  pendingComponent: ProtectedPendingSkeleton,
});
