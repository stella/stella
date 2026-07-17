import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

// One page is enough to hydrate the review panel on reload; the store
// dedups on merge and the review flow never needs the full history at
// once. Matches the server's page-size ceiling.
const DOCX_SUGGESTIONS_HYDRATION_LIMIT = 200;

type DocxSuggestionsKey = {
  workspaceId: string;
  entityId: string;
};

export const docxSuggestionsKeys = {
  all: ({ workspaceId, entityId }: DocxSuggestionsKey) => [
    ...entitiesKeys.all(workspaceId),
    entityId,
    "docx-suggestions",
  ],
};

export const docxSuggestionsOptions = ({
  workspaceId,
  entityId,
}: DocxSuggestionsKey) =>
  queryOptions({
    queryKey: docxSuggestionsKeys.all({ workspaceId, entityId }),
    queryFn: async ({ signal }) => {
      // No `status` filter: hydrate pending and resolved rows so the
      // panel's reviewed section survives a reload too.
      const response = await api["docx-suggestions"]({ workspaceId })
        .entity({ entityId })
        .get({
          query: { limit: DOCX_SUGGESTIONS_HYDRATION_LIMIT },
          fetch: { signal },
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
