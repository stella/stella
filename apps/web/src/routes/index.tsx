import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { useMountEffect } from "@/hooks/use-effect";
import { loadAuthContext } from "@/routes/-auth-context";

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

    void (async () => {
      // loadAuthContext swallows its own errors (returns a null session), so
      // this never rejects; a failed session simply routes to /auth below.
      const authContext = await loadAuthContext(queryClient);
      if (run.cancelled) {
        return;
      }

      if (!authContext.session) {
        void navigate({ to: "/auth", replace: true });
        return;
      }

      if (!authContext.session.activeOrganizationId) {
        void navigate({ to: "/auth/organization", replace: true });
        return;
      }

      void navigate({ to: "/chat", replace: true });
    })();

    return () => {
      run.cancelled = true;
    };
  });

  return <DefaultPendingComponent />;
}
