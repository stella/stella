import { useRef } from "react";

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
  const didRedirectRef = useRef(false);

  useMountEffect(() => {
    if (didRedirectRef.current) {
      return;
    }

    didRedirectRef.current = true;
    void (async () => {
      const authContext = await loadAuthContext(queryClient);

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
  });

  return <DefaultPendingComponent />;
}
