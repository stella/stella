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
    queryFn: async ({ signal }) => {
      const actorConfig = getViewsActorConfig({
        type: "vanilla",
        organizationId: context.organizationId,
        workspaceId: key.workspaceId,
        authToken: context.authToken,
      });

      const actor = rivet.views.getOrCreate(...actorConfig);

      // Timeout prevents the loader from hanging
      // indefinitely if the actor fails to respond.
      const timeout = AbortSignal.timeout(10_000);
      const combined = AbortSignal.any([signal, timeout]);

      return await new Promise<Awaited<ReturnType<typeof actor.getViews>>>(
        (resolve, reject) => {
          combined.addEventListener(
            "abort",
            () => reject(new Error("Views actor timed out")),
            { once: true },
          );
          actor.getViews().then(resolve).catch(reject);
        },
      );
    },
  });
