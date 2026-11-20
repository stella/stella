import type { QueryClient } from "@tanstack/react-query";

import type { ContactType } from "@stll/api-contract";

import { contactsQueryRoot } from "@/lib/resource-query-roots.logic";

/** What a loading contact page can draw before its read: the contact's name
 *  and whether it is a person or an organization. */
export type CachedContactSummary = {
  displayName: string;
  type: ContactType;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isContactType = (value: unknown): value is ContactType =>
  value === "person" || value === "organization";

const summaryOf = (
  value: unknown,
  contactId: string,
): CachedContactSummary | null => {
  if (!isRecord(value) || value["id"] !== contactId) {
    return null;
  }
  const { displayName, type } = value;
  return typeof displayName === "string" && isContactType(type)
    ? { displayName, type }
    : null;
};

// A contacts list holds its rows page by page.
const listedSummary = (
  data: unknown,
  contactId: string,
): CachedContactSummary | null => {
  if (!isRecord(data) || !Array.isArray(data["pages"])) {
    return null;
  }
  for (const page of data["pages"]) {
    if (!isRecord(page) || !Array.isArray(page["items"])) {
      continue;
    }
    for (const item of page["items"]) {
      const summary = summaryOf(item, contactId);
      if (summary !== null) {
        return summary;
      }
    }
  }
  return null;
};

/**
 * The contact's name and type as the cache already holds them, for a loading
 * contact page that draws the person's or the organization's sections
 * without subscribing to any read: the contact's own read when an earlier
 * visit left it, else its row in a contacts list. `null` when neither is
 * cached (a cold load, a link from elsewhere). Reads by key prefix alone, so
 * the view that calls it loads no API client.
 */
export const cachedContactSummary = (
  queryClient: QueryClient,
  contactId: string,
): CachedContactSummary | null => {
  let listed: CachedContactSummary | null = null;
  for (const [queryKey, data] of queryClient.getQueriesData<unknown>({
    queryKey: contactsQueryRoot(),
  })) {
    // A read whose last fetch failed counts as absent, as it does for the
    // page.
    const state = queryClient.getQueryState(queryKey);
    if (state === undefined || state.error !== null) {
      continue;
    }
    const own = summaryOf(data, contactId);
    if (own !== null) {
      return own;
    }
    listed ??= listedSummary(data, contactId);
  }
  return listed;
};
