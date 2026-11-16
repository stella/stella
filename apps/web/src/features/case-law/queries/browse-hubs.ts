import { queryOptions } from "@tanstack/react-query";

import { CASE_LAW_BROWSE_PAGE_SIZE } from "@stll/api-contract/case-law-browse-hubs";

import { api } from "@/lib/api";
import type { CaseLawBrowseListing } from "@/lib/case-law-browse-path";
import { caseLawBrowseDateRange } from "@/lib/case-law-browse-path";
import {
  PUBLIC_LAW_READ_TIMEOUT_MS,
  unwrapPublicLawResponse,
} from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

/**
 * The crawlable browse tree's reads: every one a bounded index read the API
 * owns (see `browse-hubs.ts` there), and the listing the public table uses.
 */

type ListingRequest = {
  country: string;
  court: string;
  target: CaseLawBrowseListing;
  /** Which language version stands for a multilingual decision. */
  readingLanguages: readonly string[];
};

const BROWSE_KEY_ROOT = "case-law-browse";

const browseKeys = {
  all: [BROWSE_KEY_ROOT],
  courts: (country: string) => [...browseKeys.all, "courts", country],
  calendar: (
    country: string,
    court: string,
    year: number | null,
    month: number | null,
  ) => [...browseKeys.all, "calendar", country, court, year, month],
  listing: (request: ListingRequest) => [...browseKeys.all, "listing", request],
};

const timeout = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(PUBLIC_LAW_READ_TIMEOUT_MS)]);

/** Every court of a jurisdiction a public page may name. */
export const caseLawBrowseCourtsOptions = (country: string) =>
  queryOptions({
    queryKey: browseKeys.courts(country),
    queryFn: async ({ signal }) =>
      unwrapPublicLawResponse(
        await api.case.browse.courts.get({
          query: { country },
          fetch: { signal: timeout(signal) },
        }),
        "listPublicCaseLawBrowseCourts",
      ),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

type CalendarRequest = {
  country: string;
  court: string;
  year?: number;
  month?: number;
};

/** The periods below one level of a court's tree that hold decisions. */
export const caseLawBrowseCalendarOptions = ({
  country,
  court,
  month,
  year,
}: CalendarRequest) =>
  queryOptions({
    queryKey: browseKeys.calendar(country, court, year ?? null, month ?? null),
    queryFn: async ({ signal }) =>
      unwrapPublicLawResponse(
        await api.case.browse.calendar.get({
          query: {
            country,
            court,
            ...(year !== undefined && { year: String(year) }),
            ...(month !== undefined && { month: String(month) }),
          },
          fetch: { signal: timeout(signal) },
        }),
        "readPublicCaseLawBrowseCalendar",
      ),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

const readBrowseListing = async (
  { country, court, readingLanguages, target }: ListingRequest,
  signal: AbortSignal,
) => {
  const offset = (target.page - 1) * CASE_LAW_BROWSE_PAGE_SIZE;
  return unwrapPublicLawResponse(
    await api.case.decisions.get({
      query: {
        country,
        court,
        ...caseLawBrowseDateRange(target),
        limit: CASE_LAW_BROWSE_PAGE_SIZE,
        ...(offset > 0 && { offset }),
        sort: "oldest",
        readingLanguages: readingLanguages.join(","),
      },
      fetch: { signal: timeout(signal) },
    }),
    "listPublicCaseLawBrowsePage",
  );
};

/** One decision as a browse listing names it. */
export type CaseLawBrowseDecision = Awaited<
  ReturnType<typeof readBrowseListing>
>["items"][number];

/**
 * One listing page of a period: the public listing, scoped to one court and
 * the period's dates, addressed by offset within its depth bound.
 */
export const caseLawBrowseListingOptions = (request: ListingRequest) =>
  queryOptions({
    queryKey: browseKeys.listing(request),
    queryFn: async ({ signal }) => await readBrowseListing(request, signal),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
