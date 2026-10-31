import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";

type MyTimeSuggestionsRange = {
  startDate: string;
  endDate: string;
  timezoneId: string;
};

export const myTimeSuggestionsKeys = {
  all: (organizationId: string) => ["myTimeSuggestions", organizationId],
  range: (
    organizationId: string,
    userId: string,
    { startDate, endDate, timezoneId }: MyTimeSuggestionsRange,
  ) => [
    ...myTimeSuggestionsKeys.all(organizationId),
    userId,
    { startDate, endDate, timezoneId },
  ],
};

const fetchMyTimeSuggestions = async (
  { startDate, endDate, timezoneId }: MyTimeSuggestionsRange,
  signal: AbortSignal,
) =>
  unwrapApiResponse(
    await api["time-entries"].me.suggestions.get({
      query: { startDate, endDate, timezoneId },
      fetch: { signal },
    }),
  );

export type MyTimeSuggestionRange = Awaited<
  ReturnType<typeof fetchMyTimeSuggestions>
>;

/** Pending suggestions across every accessible matter for up to a week. */
export const myTimeSuggestionsOptions = (
  organizationId: string,
  userId: string,
  range: MyTimeSuggestionsRange,
) =>
  queryOptions({
    queryKey: myTimeSuggestionsKeys.range(organizationId, userId, range),
    queryFn: async ({ signal }) => await fetchMyTimeSuggestions(range, signal),
  });
