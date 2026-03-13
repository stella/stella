import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { getViewsActorConfig } from "@stella/rivet/actors/views-actor-config";

import { rivet } from "@/lib/api";
import { withActorTimeout } from "@/lib/rivet";
import { sessionOptions } from "@/routes/-queries";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

export const viewsKeys = {
  all: (workspaceId: string) => ["views", workspaceId],
};

export const viewsOptions = (workspaceId: string, queryClient: QueryClient) =>
  queryOptions({
    queryKey: viewsKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const [sessionData, propertiesData] = await Promise.all([
        queryClient.ensureQueryData(sessionOptions),
        queryClient.ensureQueryData(propertiesOptions(workspaceId)),
      ]);

      if (!sessionData?.session.activeOrganizationId) {
        throw new Error("No active organization");
      }

      const actorConfig = getViewsActorConfig({
        type: "vanilla",
        organizationId: sessionData.session.activeOrganizationId,
        workspaceId,
        authToken: sessionData.session.token,
      });

      const handle = rivet.views.getOrCreate(
        ...withActorTimeout(actorConfig, signal),
      );
      const connection = handle.connect();

      return connection.getViews({
        propertyIds: propertiesData.map((p) => p.id),
      });
    },
  });
