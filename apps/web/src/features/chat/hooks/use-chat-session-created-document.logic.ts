import type { QueryClient, QueryKey } from "@tanstack/react-query";

type InvalidateCreatedDocumentQueriesOptions = {
  queryKeys: readonly QueryKey[];
  queryClient: QueryClient;
};

export const invalidateCreatedDocumentQueries = async ({
  queryKeys,
  queryClient,
}: InvalidateCreatedDocumentQueriesOptions): Promise<void> => {
  await Promise.all(
    queryKeys.map(async (queryKey) => {
      await queryClient.invalidateQueries({ queryKey });
    }),
  );
};
