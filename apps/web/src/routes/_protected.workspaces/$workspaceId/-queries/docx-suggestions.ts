import { queryOptions } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

// Server page-size ceiling; each hydration fetch requests a full page.
const DOCX_SUGGESTIONS_HYDRATION_LIMIT = 200;
// Page ALL pending rows up to this safety cap: pending drives the actionable
// panel and must never be crowded out of hydration by resolved history. Well
// past any realistic pending set for one entity; a capped pending hydration is
// reported (never silently truncated) so the missing tail is observable.
const DOCX_SUGGESTIONS_PENDING_MAX = 1000;

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

      // Page through one status (oldest first) up to `max` rows. Returns the
      // accumulated items and the live `nextCursor` so the caller can tell a
      // fully-drained status apart from one truncated by its cap.
      const pageStatus = async (
        status: "pending" | "accepted" | "rejected",
        max: number,
      ) => {
        const firstPage = await endpoint.get({
          query: { status, limit: DOCX_SUGGESTIONS_HYDRATION_LIMIT },
          fetch: { signal },
        });
        const firstData = unwrapEden(firstPage);

        const items = [...firstData.items];
        let nextCursor = firstData.nextCursor;

        while (nextCursor !== null && items.length < max) {
          // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination: each page's `nextCursor` is required to request the next
          const page = await endpoint.get({
            query: {
              status,
              limit: DOCX_SUGGESTIONS_HYDRATION_LIMIT,
              cursor: nextCursor,
            },
            fetch: { signal },
          });
          const pageData = unwrapEden(page);
          items.push(...pageData.items);
          nextCursor = pageData.nextCursor;
        }

        return { items, nextCursor };
      };

      // Hydrate only the PENDING rows — the actionable set — and page them
      // completely so history can never crowd them out. Resolved rows are
      // deliberately not re-fetched on reload: accepted changes already live
      // in the document (as tracked changes) and rejected ones are gone, so
      // the reviewed section simply starts empty. This also keeps hydration to
      // a single request per document open (the route network budget), rather
      // than fanning out to a request per status.
      const pending = await pageStatus("pending", DOCX_SUGGESTIONS_PENDING_MAX);

      // A live cursor after the pending loop means the cap stopped us short
      // with more pending rows still available. Surface it so a truncated
      // pending hydration is never silent.
      if (pending.nextCursor !== null) {
        getAnalytics().captureError(
          new Error(
            `docx-suggestions pending hydration capped at ${DOCX_SUGGESTIONS_PENDING_MAX} rows for entity ${entityId}; newer pending suggestions were not loaded`,
          ),
        );
      }

      return { items: pending.items };
    },
  });
