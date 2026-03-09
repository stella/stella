import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { getViewsActorConfig } from "@stella/rivet/actors/views-actor-config";

import { useActor } from "@/lib/api";
import { sessionOptions } from "@/routes/-queries";

export const useViewsActor = (workspaceId: string) => {
  const { data } = useSuspenseQuery(sessionOptions);
  const organizationId = useRouteContext({
    from: "/_protected/workspaces/$workspaceId",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const actor = useActor(
    getViewsActorConfig({
      type: "react",
      organizationId,
      authToken: data?.session.token,
      workspaceId,
    }),
  );

  return actor;
};
