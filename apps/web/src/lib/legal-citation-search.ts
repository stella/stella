import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import {
  readDecisionIntent,
  readDecisionMatch,
} from "@/features/case-law/open-decision-match";
import { readStatuteMatch } from "@/features/statutes/open-statute-match";
import { readStatuteIntent } from "@/features/statutes/statute-index-search.logic";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { isPublicStatuteCountry } from "@/lib/statutes/statute-route";

type LegalCitationSearchInput = {
  country: string;
  query: string;
};

/** Uses the legal database's grammars, including docket sheets and act aliases. */
const legalCitationSearchIntent = ({
  country,
  query,
}: LegalCitationSearchInput) => {
  const statuteCountry = country.toLowerCase();
  if (
    isPublicStatuteCountry(statuteCountry) &&
    readStatuteIntent(statuteCountry, query).type === "act"
  ) {
    return { type: "statute", country: statuteCountry } as const;
  }
  return readDecisionIntent(query, { jurisdiction: country }).type ===
    "identifier"
    ? ({ type: "decision", country } as const)
    : ({ type: "text" } as const);
};

export const isLegalCitationSearch = (
  input: LegalCitationSearchInput,
): boolean => legalCitationSearchIntent(input).type !== "text";

type LegalCitationSearchOptions = LegalCitationSearchInput & {
  queryClient: QueryClient;
};

export const readLegalCitationSearch = async ({
  country,
  query,
  queryClient,
}: LegalCitationSearchOptions) => {
  const intent = legalCitationSearchIntent({ country, query });
  switch (intent.type) {
    case "text":
      return { type: "none" } as const;
    case "statute": {
      const match = await readStatuteMatch({
        country: intent.country,
        q: query,
        queryClient,
      });
      return match === null
        ? ({ type: "none" } as const)
        : ({ type: "statutes", ...match } as const);
    }
    case "decision": {
      const resolution = await readDecisionMatch({
        excerpt: DEFAULT_SEARCH_EXCERPT,
        queryClient,
        search: { country: intent.country, q: query },
      });
      if (resolution === null) {
        return { type: "none" } as const;
      }
      switch (resolution.status) {
        case "none":
          return { type: "none" } as const;
        case "unique":
          return {
            type: "decisions",
            items: [resolution.decision],
            resolution,
          } as const;
        case "ambiguous":
        case "incomplete_identifier":
          return {
            type: "decisions",
            items: resolution.candidates,
            resolution,
          } as const;
        default:
          resolution satisfies never;
          return panic("Unknown decision citation resolution");
      }
    }
    default:
      intent satisfies never;
      return panic("Unknown legal citation intent");
  }
};

export const legalCitationSearchOptions = ({
  country,
  query,
}: LegalCitationSearchInput) =>
  queryOptions({
    queryKey: ["legal-citation-search", country, query],
    queryFn: ({ client }) =>
      readLegalCitationSearch({ country, query, queryClient: client }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
