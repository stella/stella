import type { QueryClient } from "@tanstack/react-query";

import { entityOptions } from "@/lib/workspaces/queries/entities";
import { resolveCanonicalDocumentDestination } from "@/lib/workspaces/resolve-document-destination";

type ResolveCanonicalDocumentDestinationQueryOptions = {
  entityId: unknown;
  fieldId: unknown;
  queryClient: QueryClient;
  workspaceId: string;
};

export const resolveCanonicalDocumentDestinationQuery = async ({
  entityId,
  fieldId,
  queryClient,
  workspaceId,
}: ResolveCanonicalDocumentDestinationQueryOptions) =>
  await resolveCanonicalDocumentDestination({
    entityId,
    fieldId,
    loadCurrentFields: async ({
      entityId: currentEntityId,
      workspaceId: currentWorkspaceId,
    }) => {
      const entity = await queryClient.query({
        ...entityOptions(currentWorkspaceId, currentEntityId),
        staleTime: 0,
      });
      return entity.fields;
    },
    workspaceId,
  });
