import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { ensureRouteQueryData } from "@/lib/react-query";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

type RedirectToDefaultWorkspaceViewInput = {
  queryClient: QueryClient;
  workspaceId: string;
};

export const redirectToDefaultWorkspaceView = async ({
  queryClient,
  workspaceId,
}: RedirectToDefaultWorkspaceViewInput): Promise<never> => {
  const options = viewsOptions(workspaceId);

  // Avoid serving stale cache from a previous workspace that had no views.
  await queryClient.invalidateQueries({ queryKey: options.queryKey });

  const views = await ensureRouteQueryData(queryClient, options);
  const firstView = views.at(0);

  if (!firstView) {
    throw redirect({ to: "/workspaces", replace: true });
  }

  throw redirect({
    to: "/workspaces/$workspaceId/$viewId",
    params: {
      workspaceId,
      viewId: firstView.id,
    },
    replace: true,
  });
};
