import { queryOptions } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

// Server page-size ceiling; each hydration fetch requests a full page.
const DOCX_SUGGESTIONS_HYDRATION_LIMIT = 200;
// Page ALL pending rows up to this safety cap: pending drives the actionable
// panel and must never be crowded out of hydration by resolved history. Well
// past any realistic pending set for one entity; a capped pending hydration is
// reported (never silently truncated) so the missing tail is observable.
const DOCX_SUGGESTIONS_PENDING_MAX = 1000;
// Resolved history (accepted / rejected) is hydrated best-effort so the panel's
// reviewed section survives a reload, capped per status so old resolutions can
// never starve the pending set. Truncating this tail is acceptable.
const DOCX_SUGGESTIONS_RESOLVED_MAX = 200;

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
        if (firstPage.error) {
          throw toAPIError(firstPage.error);
        }

        const items = [...firstPage.data.items];
        let nextCursor = firstPage.data.nextCursor;

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
          if (page.error) {
            throw toAPIError(page.error);
          }
          items.push(...page.data.items);
          nextCursor = page.data.nextCursor;
        }

        return { items, nextCursor };
      };

      // Hydrate pending completely and resolved history best-effort, in
      // parallel to minimize round-trips. Pending is never truncated by
      // history because it pages under its own high cap.
      const [pending, accepted, rejected] = await Promise.all([
        pageStatus("pending", DOCX_SUGGESTIONS_PENDING_MAX),
        pageStatus("accepted", DOCX_SUGGESTIONS_RESOLVED_MAX),
        pageStatus("rejected", DOCX_SUGGESTIONS_RESOLVED_MAX),
      ]);

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

      return {
        items: [...pending.items, ...accepted.items, ...rejected.items],
      };
    },
  });
