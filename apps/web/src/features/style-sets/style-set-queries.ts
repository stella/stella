import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";

const STYLE_SETS_PAGE_SIZE = 100;

export const styleSetsKeys = {
  all: (organizationId: string) => ["style-sets", organizationId],
  list: (organizationId: string) => [
    ...styleSetsKeys.all(organizationId),
    "list",
  ],
};

export const styleSetsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: styleSetsKeys.list(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"].get({
        query: { limit: STYLE_SETS_PAGE_SIZE },
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
