import { queryOptions } from "@tanstack/react-query";

import { getViewsActorConfig } from "@stella/rivet/actors/views-actor-config";

import { rivet } from "@/lib/api";
import type { QueryOptionsInput } from "@/lib/react-query";

const viewsKeys = {
  all: (workspaceId: string) => ["views", workspaceId],
};

type ViewsOptionsInput = QueryOptionsInput<
  { workspaceId: string },
  { organizationId: string; authToken: string }
>;

export const viewsOptions = ({ key, context }: ViewsOptionsInput) =>
  queryOptions({
    queryKey: viewsKeys.all(key.workspaceId),
    queryFn: async () => {
      const actorConfig = getViewsActorConfig({
        type: "vanilla",
        organizationId: context.organizationId,
        workspaceId: key.workspaceId,
        authToken: context.authToken,
      });

      const actor = rivet.views.getOrCreate(...actorConfig);

      return await actor.getViews();
    },
  });
