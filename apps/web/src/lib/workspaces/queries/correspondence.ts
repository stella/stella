import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type {
  CorrespondenceAddress,
  CorrespondenceAuthResult,
  CorrespondenceHandlingState,
} from "@stll/api-contract/correspondence";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { correspondenceQueryRoot } from "@/lib/resource-query-roots.logic";

const getInitialCorrespondencePageParam = (): string | undefined => undefined;

export const CORRESPONDENCE_STATE_LABEL_KEYS = {
  new: "inbox.view.new",
  handled: "correspondence.states.handled",
} as const satisfies Record<CorrespondenceHandlingState, TranslationKey>;

export const CORRESPONDENCE_AUTH_LABEL_KEYS = {
  pass: "correspondence.authResults.pass",
  fail: "correspondence.authResults.fail",
  none: "common.none",
  unknown: "correspondence.authResults.unknown",
} as const satisfies Record<CorrespondenceAuthResult, TranslationKey>;

export const correspondenceKeys = {
  all: correspondenceQueryRoot,
  infinite: (workspaceId: string, limit: number) =>
    [...correspondenceKeys.all(workspaceId), "infinite", { limit }] as const,
  byId: (workspaceId: string, id: string) =>
    [...correspondenceKeys.all(workspaceId), id] as const,
  address: (workspaceId: string) =>
    [...correspondenceKeys.all(workspaceId), "address"] as const,
};

export const uniqueCorrespondenceAddresses = (
  addresses: CorrespondenceAddress[],
) => {
  const seen = new Set<string>();
  return addresses.filter(({ address }) => {
    const key = address.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export const correspondenceInfiniteOptions = (
  workspaceId: string,
  limit: number,
) =>
  infiniteQueryOptions({
    queryKey: correspondenceKeys.infinite(workspaceId, limit),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence.get({
          query: {
            limit,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        });
      return unwrapEden(response);
    },
    initialPageParam: getInitialCorrespondencePageParam(),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const correspondenceByIdOptions = (
  workspaceId: string,
  correspondenceId: string,
) =>
  queryOptions({
    queryKey: correspondenceKeys.byId(workspaceId, correspondenceId),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence({ correspondenceId })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
  });

export const correspondenceAddressOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: correspondenceKeys.address(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence.address.get({ fetch: { signal } });
      return unwrapEden(response);
    },
  });
