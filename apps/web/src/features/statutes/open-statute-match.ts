import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";

import type { StatuteQueryIntent } from "@stll/api-contract/statute-query-intent";
import { createStatuteRouteParams } from "@stll/api-contract/statute-route";

import {
  type StatuteListFilters,
  statutesInfiniteOptions,
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

/** Shared act lookup for the legal database and global search. */
export const readStatuteMatch = async ({
  country,
  q,
  queryClient,
}: Omit<OpenStatuteMatchOptions, "navigate">) => {
  const intent = readStatuteIntent(country, q);
  if (intent.type !== "act") {
    return null;
  }
  const pages = await ensureRouteInfiniteQueryData(
    queryClient,
    statutesInfiniteOptions(createStatuteFilters(country, intent)),
  );
  const page = pages.pages.at(0);
  if (page === undefined) {
    return panic("Statute lookup must return its initial page");
  }
  return { intent, items: page.items };
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
  const match = await readStatuteMatch({ country, q, queryClient });
  const only = match?.items.length === 1 ? match.items.at(0) : undefined;
  if (only === undefined || match === null) {
    return false;
  }
  const { intent } = match;

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
