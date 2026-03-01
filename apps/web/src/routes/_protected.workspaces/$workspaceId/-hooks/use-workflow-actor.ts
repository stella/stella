import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";

import { useActor } from "@/lib/api";
import { sessionOptions } from "@/routes/-queries";

export const useWorkflowActor = (workspaceId: string) => {
  const { data } = useSuspenseQuery(sessionOptions);
  const organizationId = useRouteContext({
    from: "/_protected/workspaces/$workspaceId",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const actor = useActor(
    getWorkflowActorConfig({
      type: "react",
      organizationId,
      authToken: data?.session.token,
      workspaceId,
    }),
  );

  return actor;
};
