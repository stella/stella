import { useRouter, useRouterState } from "@tanstack/react-router";

import {
  DefaultPendingComponent,
  PENDING_STATUS_PROPS,
} from "@/components/route-components";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { matchedAppFrameScope } from "@/routes/-app-frame-scope";
import { selectAppFrame } from "@/routes/-app-frame.logic";
import { ProtectedPendingSkeleton } from "@/routes/-protected-pending-skeleton";
import {
  leafRedirectFrameScope,
  PendingViewOf,
  useLeafPendingView,
} from "@/routes/-route-pending-view";
import { AuthFrameShell } from "@/routes/auth/-auth-frame.pending";

/**
 * The root's pending view: what a cold load paints before the app mounts,
 * on the server for every page that does not render there. The matches are
 * resolved from the URL before any loader runs, so a page in the member frame
 * paints that frame here already, with the page's own pending view as its
 * body, and the frame host's skeleton that follows has the same shape.
 * Auth pages share their header and form column with the mounted auth frame.
 */
export function RootPendingComponent() {
  const router = useRouter();
  const frame = useRouterState({
    select: (state) =>
      selectAppFrame({
        scope: matchedAppFrameScope(state.matches),
        routeIds: state.matches.map((match) => match.routeId),
        // No guard has run yet: a member page answers with the frame it
        // shows while the session is read.
        hasRouteUser: false,
        publicKnowledge: isPublicKnowledgeEnabled(),
        redirectScope: leafRedirectFrameScope(router.routesById, state.matches),
      }),
  });
  const pagePending = useLeafPendingView();
  if (frame === "auth") {
    return (
      <div {...PENDING_STATUS_PROPS}>
        <AuthFrameShell>
          {pagePending ? (
            <PendingViewOf view={pagePending} />
          ) : (
            <DefaultPendingComponent announce={false} />
          )}
        </AuthFrameShell>
      </div>
    );
  }
  if (frame !== "checking" && frame !== "neutral") {
    return <DefaultPendingComponent className="h-dvh" />;
  }
  return (
    // The layout `RootApp` gives the frame host, and the one announced busy
    // region; the frame skeleton inside is decoration. No intl here: the
    // client hydrates this paint before it restores the account's locale, so
    // its labels are bars until the frame host's skeleton takes over.
    <div {...PENDING_STATUS_PROPS} className="flex h-dvh w-full flex-col">
      <ProtectedPendingSkeleton body={pagePending} />
    </div>
  );
}
