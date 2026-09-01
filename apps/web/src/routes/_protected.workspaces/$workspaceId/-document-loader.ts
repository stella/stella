import type { QueryClient } from "@tanstack/react-query";

import { detached } from "@/lib/detached";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { prefetchRouteQuery } from "@/lib/react-query";

type LoadDocumentEntityWithChatPrefetchArgs<TEntity> = {
  activeOrganizationId: string;
  captureError: (error: unknown) => void;
  loadEntity: () => Promise<TEntity>;
  queryClient: QueryClient;
};

export const loadDocumentEntityWithChatPrefetch = async <TEntity>({
  activeOrganizationId,
  captureError,
  loadEntity,
  queryClient,
}: LoadDocumentEntityWithChatPrefetchArgs<TEntity>): Promise<TEntity> => {
  // The file chat overlay suspends on its file-thread binding before the
  // chat session mounts and reads the MCP catalogue. Start that catalogue
  // before the entity gate so it cannot become a later causal round.
  detached(
    prefetchRouteQuery(
      queryClient,
      mcpConnectorsOptions(activeOrganizationId),
      captureError,
    ),
    "document.prefetch",
  );

  return await loadEntity();
};
