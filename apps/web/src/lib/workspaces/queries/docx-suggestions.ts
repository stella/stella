import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import {
  DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
  DOCX_SUGGESTIONS_PENDING_MAX,
} from "@stll/api-contract";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import type { WebApiRoutes } from "@/lib/eden-client";
import { unwrapEden } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

/**
 * Responses carry timestamps as ISO strings. Hydration, the pending-list cache
 * and the review store need real Dates, so every response carrying a
 * suggestion `createdAt` is read through here.
 */
export const readDocxSuggestionCreatedAt = (value: string): Date =>
  parseDeterministicDate(value) ??
  panic("The DOCX suggestion API returned an invalid createdAt");

type SerializedDocxSuggestion =
  WebApiRoutes["docx-suggestions"][":workspaceId"]["entity"][":entityId"]["get"]["response"][200]["items"][number];

const readDocxSuggestionItem = ({
  createdAt,
  ...item
}: SerializedDocxSuggestion) => ({
  ...item,
  createdAt: readDocxSuggestionCreatedAt(createdAt),
});

// Each hydration fetch requests a full page.
// Page ALL pending rows up to DOCX_SUGGESTIONS_PENDING_MAX: pending drives the
// actionable panel and must never be crowded out of hydration by resolved
// history. A capped pending hydration is reported (never silently truncated)
// so the missing tail is observable.

type DocxSuggestionsKey = {
  workspaceId: string;
  entityId: string;
};

const docxSuggestionsKeys = {
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
          query: { status, limit: DOCX_SUGGESTIONS_PAGE_SIZE_MAX },
          fetch: { signal },
        });
        const firstData = unwrapEden(firstPage);

        const items = [...firstData.items];
        let nextCursor = firstData.nextCursor;

        while (nextCursor !== null && items.length < max) {
          const page = await endpoint.get({
            query: {
              status,
              limit: DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
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

      return {
        items: pending.items.map(readDocxSuggestionItem),
      };
    },
  });
