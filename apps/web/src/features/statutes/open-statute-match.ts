import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

import {
  statutesInfiniteOptions,
  type StatuteListFilters,
} from "@/features/statutes/queries/statutes";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@/features/statutes/statute-query-intent";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import {
  isStatuteCountry,
  type StatuteCountry,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

/**
 * What an entry asks for in this jurisdiction. A country the grammar does
 * not know reads every entry as text.
 */
export const readStatuteIntent = (
  country: string,
  q: string | undefined,
): StatuteQueryIntent => {
  if (q === undefined) {
    return { type: "empty" };
  }
  return isStatuteCountry(country)
    ? parseStatuteQuery(country, q)
    : { type: "text", text: q };
};

export const createStatuteFilters = (
  country: string,
  intent: StatuteQueryIntent,
): StatuteListFilters => {
  const scope = { country: country.toUpperCase() };
  switch (intent.type) {
    case "empty":
      return scope;
    case "act":
      return {
        ...scope,
        number: `${intent.number}/${intent.year}`,
        ...(intent.collection === null
          ? {}
          : { collection: intent.collection }),
      };
    case "text":
      return { ...scope, query: intent.text };
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
};

type OpenStatuteMatchOptions = {
  country: StatuteCountry;
  navigate: ReturnType<typeof useNavigate>;
  q: string;
  queryClient: QueryClient;
};

/**
 * Open the act the entry names, when exactly one work answers to it. Several
 * (the same number in two collections) are left to the reader to choose
 * between, so the caller falls back to its list; the return value says which
 * happened.
 */
export const openStatuteMatch = async ({
  country,
  navigate,
  q,
  queryClient,
}: OpenStatuteMatchOptions): Promise<boolean> => {
  const intent = readStatuteIntent(country, q);
  if (intent.type !== "act") {
    return false;
  }

  const pages = await ensureRouteInfiniteQueryData(
    queryClient,
    statutesInfiniteOptions(createStatuteFilters(country, intent)),
  );
  const firstPage = pages.pages.at(0);
  if (firstPage?.items.length !== 1) {
    return false;
  }
  const only = firstPage.items.at(0);
  if (only === undefined) {
    return false;
  }

  await navigate({
    params: {
      country: toStatuteCountrySegment(only.country),
      documentId: only.id,
    },
    search: intent.provision === null ? {} : { jump: intent.provision },
    to: "/law/$country/statutes/$documentId",
  });

  return true;
};
