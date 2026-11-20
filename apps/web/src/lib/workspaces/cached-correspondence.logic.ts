import type { QueryClient } from "@tanstack/react-query";

import type {
  CorrespondenceDetailResponse,
  CorrespondenceListResponse,
} from "@stll/api-contract/correspondence";

import { correspondenceQueryRoot } from "@/lib/resource-query-roots.logic";

type CorrespondenceRecord = CorrespondenceListResponse["items"][number];

/** What a loading message page can draw before its read: its subject, how it
 *  came in and whether it is handled. */
export type CachedCorrespondenceSummary = Pick<
  CorrespondenceRecord,
  "channel" | "handlingState" | "source" | "subject"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const summaryOf = (
  record: CorrespondenceRecord,
): CachedCorrespondenceSummary => ({
  channel: record.channel,
  handlingState: record.handlingState,
  source: record.source,
  subject: record.subject,
});

const isDetail = (data: unknown): data is CorrespondenceDetailResponse =>
  isRecord(data) && isRecord(data["record"]);

const isList = (
  data: unknown,
): data is { pages: readonly CorrespondenceListResponse[] } =>
  isRecord(data) && Array.isArray(data["pages"]);

/**
 * A message's subject, channel, source and handling state as the cache
 * already holds them, for a loading message page that draws the sections
 * that message will have without subscribing to any read: the message's own
 * read when an earlier visit left it, else its row in the matter's list.
 * `null` when neither is cached. Reads by key prefix alone, so the view that
 * calls it loads no API client.
 */
export const cachedCorrespondenceSummary = (
  queryClient: QueryClient,
  {
    correspondenceId,
    workspaceId,
  }: { correspondenceId: string; workspaceId: string },
): CachedCorrespondenceSummary | null => {
  let listed: CachedCorrespondenceSummary | null = null;
  for (const [queryKey, data] of queryClient.getQueriesData({
    queryKey: correspondenceQueryRoot(workspaceId),
  })) {
    // A read whose last fetch failed counts as absent, as it does for the
    // page.
    const state = queryClient.getQueryState(queryKey);
    if (state === undefined || state.error !== null) {
      continue;
    }
    if (isDetail(data) && data.record.id === correspondenceId) {
      return summaryOf(data.record);
    }
    if (listed === null && isList(data)) {
      const row = data.pages
        .flatMap((page) => page.items)
        .find((item) => item.id === correspondenceId);
      listed = row === undefined ? null : summaryOf(row);
    }
  }
  return listed;
};
