import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { loadAuthContextForRootRedirect } from "@/routes/-auth-context";

export const Route = createFileRoute("/")({
  component: RootRedirect,
});

// Dispatch from a mounted component instead of throwing redirect from
// beforeLoad: an unconditional beforeLoad redirect (every branch here
// redirects) blanks the page on cold direct loads, since the router
// can render this redirected match while the suspending target (e.g.
// /chat) holds the transition open. See `no-beforeload-redirect`.
function RootRedirect() {
  const navigate = useNavigate();
  const queryClient = Route.useRouteContext({
    select: (context) => context.queryClient,
  });

  useMountEffect(() => {
    // A holder (not a closure `let`) so the cleanup's write is visible to the
    // async read without tripping no-unnecessary-condition narrowing. It also
    // doubles as the StrictMode guard: the first (cancelled) pass bails and the
    // second navigates, and a real unmount before auth resolves bails too, so a
    // stale completion cannot hijack the user's new location.
    const run = { cancelled: false };

    detached(
      (async () => {
        const authContext = await loadAuthContextForRootRedirect(queryClient);
        if (run.cancelled) {
          return;
        }

        if (!authContext.session) {
          detached(navigate({ to: "/auth", replace: true }), "root.navigate");
          return;
        }

        if (!authContext.session.activeOrganizationId) {
          detached(
            navigate({ to: "/auth/organization", replace: true }),
            "root.navigate",
          );
          return;
        }

        detached(navigate({ to: "/chat", replace: true }), "root.navigate");
      })(),
      "root.load-auth-context",
    );

    return () => {
      run.cancelled = true;
    };
  });

  return <DefaultPendingComponent />;
}
