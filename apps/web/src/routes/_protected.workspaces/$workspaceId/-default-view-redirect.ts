import { useState } from "react";

import type { QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useMountEffect } from "@/hooks/use-effect";
import { ensureRouteQueryData } from "@/lib/react-query";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

type DefaultWorkspaceViewInput = {
  queryClient: QueryClient;
  workspaceId: string;
};

type DefaultWorkspaceViewTarget =
  | { to: "/workspaces" }
  | {
      to: "/workspaces/$workspaceId/$viewId";
      params: { workspaceId: string; viewId: string };
    };

// Resolve where `/workspaces/$workspaceId` should land — its first view, or the
// workspace list when it has none. Returns the target instead of throwing a
// router redirect so it can drive a mounted-component navigation: a beforeLoad
// throw-redirect on this client-only route blanks the page on cold direct
// loads (see the no-beforeload-redirect lint rule).
const resolveDefaultWorkspaceViewTarget = async ({
  queryClient,
  workspaceId,
}: DefaultWorkspaceViewInput): Promise<DefaultWorkspaceViewTarget> => {
  const options = viewsOptions(workspaceId);

  // Avoid serving stale cache from a previous workspace that had no views.
  await queryClient.invalidateQueries({ queryKey: options.queryKey });

  const views = await ensureRouteQueryData(queryClient, options);
  const firstView = views.at(0);

  if (!firstView) {
    return { to: "/workspaces" };
  }

  return {
    to: "/workspaces/$workspaceId/$viewId",
    params: { workspaceId, viewId: firstView.id },
  };
};

// Mounted-component redirect to the workspace's default view. Shared by the
// `/workspaces/$workspaceId` index and the disabled `timesheets` alias. The
// cancel holder bails if the user leaves before the view resolves (and doubles
// as the StrictMode guard); callers render a static pending splash meanwhile.
export const useDefaultWorkspaceViewRedirect = ({
  queryClient,
  workspaceId,
}: DefaultWorkspaceViewInput) => {
  const navigate = useNavigate();
  const [viewError, setViewError] = useState<Error | null>(null);

  useMountEffect(() => {
    const run = { cancelled: false };

    void (async () => {
      try {
        const target = await resolveDefaultWorkspaceViewTarget({
          queryClient,
          workspaceId,
        });
        if (run.cancelled) {
          return;
        }

        if (target.to === "/workspaces") {
          void navigate({ to: "/workspaces", replace: true });
          return;
        }

        void navigate({
          to: "/workspaces/$workspaceId/$viewId",
          params: target.params,
          replace: true,
        });
      } catch (error) {
        if (!run.cancelled) {
          setViewError(
            error instanceof Error
              ? error
              : new Error("Failed to resolve the default workspace view"),
          );
        }
      }
    })();

    return () => {
      run.cancelled = true;
    };
  });

  // Surface a view-load failure to the nearest route error boundary, matching
  // the old beforeLoad behavior (its rejection reached the boundary). Without
  // this the route would hang on the pending splash forever. Thrown after the
  // hooks above so hook order stays stable across the error re-render.
  if (viewError) {
    throw viewError;
  }
};
