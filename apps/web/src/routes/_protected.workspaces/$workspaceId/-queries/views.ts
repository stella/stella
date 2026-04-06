import { queryOptions } from "@tanstack/react-query";

import { getViewsActorConfig } from "@stella/rivet/actors/views-actor-config";
import { withTimeout } from "@stella/rivet/timeout";

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
    queryFn: async ({ signal }) => {
      const actorConfig = getViewsActorConfig({
        type: "vanilla",
        organizationId: context.organizationId,
        workspaceId: key.workspaceId,
        authToken: context.authToken,
      });

      const actor = rivet.views.getOrCreate(...actorConfig);

      return await withTimeout({
        signal,
        timeoutMs: 10_000,
        timeoutMessage: "Views actor timed out",
        run: async () => await actor.getViews(),
      });
    },
  });
