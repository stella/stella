import { queryOptions } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

// Server page-size ceiling; each hydration fetch requests a full page.
const DOCX_SUGGESTIONS_HYDRATION_LIMIT = 200;
// Hard cap on rows pulled while paging through the persisted suggestions.
// Well past any realistic pending set for one entity; a capped hydration is
// reported (never silently truncated) so the missing tail is observable.
const DOCX_SUGGESTIONS_HYDRATION_MAX = 500;

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
      const endpoint = api["docx-suggestions"]({ workspaceId }).entity({
        entityId,
      });

      // Page through every persisted row (oldest first). Without this a large
      // pending set would hydrate only its first page, dropping newer rows
      // after reload. No `status` filter: hydrate pending and resolved rows so
      // the panel's reviewed section survives a reload too.
      const firstPage = await endpoint.get({
        query: { limit: DOCX_SUGGESTIONS_HYDRATION_LIMIT },
        fetch: { signal },
      });
      if (firstPage.error) {
        throw toAPIError(firstPage.error);
      }

      const items = [...firstPage.data.items];
      let nextCursor = firstPage.data.nextCursor;

      while (
        nextCursor !== null &&
        items.length < DOCX_SUGGESTIONS_HYDRATION_MAX
      ) {
        // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination: each page's `nextCursor` is required to request the next
        const page = await endpoint.get({
          query: {
            limit: DOCX_SUGGESTIONS_HYDRATION_LIMIT,
            cursor: nextCursor,
          },
          fetch: { signal },
        });
        if (page.error) {
          throw toAPIError(page.error);
        }
        items.push(...page.data.items);
        nextCursor = page.data.nextCursor;
      }

      // Exited the loop with a live cursor means the cap stopped us short with
      // more rows still available. Surface it so a truncated hydration is never
      // silent.
      if (nextCursor !== null) {
        getAnalytics().captureError(
          new Error(
            `docx-suggestions hydration capped at ${DOCX_SUGGESTIONS_HYDRATION_MAX} rows for entity ${entityId}; newer persisted suggestions were not loaded`,
          ),
        );
      }

      return { items };
    },
  });
