import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";

import type { StatuteQueryIntent } from "@stll/api-contract/statute-query-intent";
import { createStatuteRouteParams } from "@stll/api-contract/statute-route";

import {
  statutesInfiniteOptions,
  type StatuteListFilters,
} from "@/features/statutes/queries/statutes";
import { readStatuteIntent } from "@/features/statutes/statute-index-search.logic";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import type { StatuteCountry } from "@/lib/statutes/statute-route";

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
      intent satisfies never;
      return panic(`Unhandled intent: ${String(intent)}`);
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

  const params = createStatuteRouteParams({
    country: only.country,
    documentId: only.id,
    eli: only.eli,
    slug: only.slug,
    version: null,
  });

  await navigate({
    params: { country: params.country, slug: params.slug },
    search: intent.provision === null ? {} : { jump: intent.provision },
    to: "/law/$country/statutes/$slug",
  });

  return true;
};
